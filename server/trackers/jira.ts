import * as canonicalLog from "../canonical-log.ts";
import type { JiraClient, JiraIssue } from "../jira-client.ts";
import { resolveRepo } from "../scope-resolver.ts";
import { issueKey, issueNumber, type RepoSlug } from "../types/brands.ts";
import { err, ok } from "../types/result.ts";
import { decorateTracker } from "./decorator.ts";
import type { Issue, TrackerAdapter, TrackerState } from "./types.ts";

type JiraStatuses = Record<TrackerState, string>;

type JiraTrackerOptions = {
	project: string;
	scopes: readonly RepoSlug[];
	baseUrl: string;
	statuses: JiraStatuses;
	triggerLabel: string;
};

const REPO_LABEL_PREFIX = "repo:";

type DropReason =
	| "no_repo_label"
	| "multiple_repo_labels"
	| "unresolved_repo_label";

function jiraIssueKey(project: string, num: number): string {
	return `${project}-${num}`;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function quoteJqlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value))
		return value.map(extractText).filter(Boolean).join("\n");
	if (value !== null && typeof value === "object") {
		if ("text" in value && typeof value.text === "string") return value.text;
		if ("content" in value && Array.isArray(value.content))
			return extractText(value.content);
	}
	return "";
}

function parseJiraKey(project: string, key: string): number | null {
	const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/.exec(key);
	const matchedProject = match?.[1];
	const matchedNumber = match?.[2];
	if (!matchedProject || !matchedNumber || matchedProject !== project) {
		return null;
	}
	return Number.parseInt(matchedNumber, 10);
}

export function jiraTrackerAdapter(
	client: JiraClient,
	options: JiraTrackerOptions,
): TrackerAdapter {
	const baseUrl = trimTrailingSlash(options.baseUrl);

	function logDrop(issueKeyValue: string, reason: DropReason): void {
		canonicalLog.append("dropped_issues", {
			event: "issue_dropped",
			reason,
			issueKey: issueKeyValue,
		});
	}

	function buildIssue(issue: JiraIssue, repo: RepoSlug): Issue {
		const num = parseJiraKey(options.project, issue.key);
		/* v8 ignore next 3 -- defensive check; Jira API returns keys matching its own search filter */
		if (num == null) {
			throw new Error(`Invalid Jira issue key from API: ${issue.key}`);
		}
		return {
			key: issueKey(issue.key),
			number: issueNumber(num),
			repo,
			title: issue.fields.summary,
			description: extractText(issue.fields.description),
			labels: issue.fields.labels,
			url: `${baseUrl}/browse/${issue.key}`,
			createdAt: issue.fields.created,
		};
	}

	function resolveScopedIssue(issue: JiraIssue): Issue | null {
		const repoLabels = issue.fields.labels.filter((l) =>
			l.startsWith(REPO_LABEL_PREFIX),
		);
		const [first, second] = repoLabels;
		if (!first) {
			logDrop(issue.key, "no_repo_label");
			return null;
		}
		if (second) {
			logDrop(issue.key, "multiple_repo_labels");
			return null;
		}
		const path = first.slice(REPO_LABEL_PREFIX.length);
		const resolved = resolveRepo(path, options.scopes);
		if (!resolved) {
			logDrop(issue.key, "unresolved_repo_label");
			return null;
		}
		return buildIssue(issue, resolved);
	}

	return decorateTracker({
		async fetchIssue(repo, issueNum): Promise<Issue> {
			const issue = await client.getIssue(
				jiraIssueKey(options.project, issueNum),
			);
			return buildIssue(issue, repo);
		},

		async fetchActiveIssues(state) {
			const clauses = [
				`project = ${quoteJqlString(options.project)}`,
				`status = ${quoteJqlString(options.statuses[state])}`,
				`labels = ${quoteJqlString(options.triggerLabel)}`,
				"reporter = currentUser()",
			];
			const jql = `${clauses.join(" AND ")} ORDER BY created ASC`;
			const raw = await client.searchIssues({ jql, maxResults: 100 });
			const issues: Issue[] = [];
			const reposReached = new Set<RepoSlug>(options.scopes);
			for (const r of raw) {
				const mapped = resolveScopedIssue(r);
				if (mapped) {
					issues.push(mapped);
					reposReached.add(mapped.repo);
				}
			}
			return { issues, reposReached };
		},

		async transitionState(_repo, issueNum, _from, to): Promise<void> {
			const key = jiraIssueKey(options.project, issueNum);
			const targetStatus = options.statuses[to];
			const transitions = await client.listTransitions(key);
			const transition = transitions.find((t) => t.to.name === targetStatus);
			if (!transition) {
				throw new Error(
					`No Jira transition for ${key} to status ${targetStatus}`,
				);
			}
			await client.transitionIssue(key, transition.id);
		},

		parseIssueKey(key) {
			const num = parseJiraKey(options.project, key);
			if (num == null) {
				return err({
					kind: "invalid_format",
					input: key,
					message: `Invalid Jira issue key: ${key}`,
				});
			}
			return ok({
				number: issueNumber(num),
			});
		},
	});
}
