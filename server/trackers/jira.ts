import type { JiraClient, JiraIssue } from "../jira-client.ts";
import { issueKey, issueNumber, type RepoSlug } from "../types/brands.ts";
import { err, ok } from "../types/result.ts";
import { decorateTracker } from "./decorator.ts";
import type { Issue, TrackerAdapter, TrackerState } from "./types.ts";

type JiraStatuses = Record<TrackerState, string>;

type JiraTrackerOptions = {
	project: string;
	repo: RepoSlug;
	baseUrl: string;
	statuses: JiraStatuses;
	labels?: readonly string[];
};

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

	function mapIssue(issue: JiraIssue): Issue {
		const num = parseJiraKey(options.project, issue.key);
		/* v8 ignore next 3 -- defensive check; Jira API returns keys matching its own search filter */
		if (num == null) {
			throw new Error(`Invalid Jira issue key from API: ${issue.key}`);
		}
		return {
			key: issueKey(issue.key),
			number: issueNumber(num),
			repo: options.repo,
			title: issue.fields.summary,
			description: extractText(issue.fields.description),
			labels: [issue.fields.status.name],
			url: `${baseUrl}/browse/${issue.key}`,
			createdAt: issue.fields.created,
		};
	}

	return decorateTracker({
		async fetchIssue(_repo, issueNum): Promise<Issue> {
			const issue = await client.getIssue(
				jiraIssueKey(options.project, issueNum),
			);
			return mapIssue(issue);
		},

		async fetchActiveIssues(state) {
			const clauses = [
				`project = ${quoteJqlString(options.project)}`,
				`status = ${quoteJqlString(options.statuses[state])}`,
			];
			if (options.labels && options.labels.length > 0) {
				const quoted = options.labels.map(quoteJqlString).join(", ");
				clauses.push(`labels in (${quoted})`);
			}
			const jql = `${clauses.join(" AND ")} ORDER BY created ASC`;
			const raw = await client.searchIssues({ jql, maxResults: 100 });
			return {
				issues: raw.map(mapIssue),
				reposReached: new Set([options.repo]),
			};
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
