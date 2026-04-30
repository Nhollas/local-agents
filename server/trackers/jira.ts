import type { JiraClient, JiraIssue } from "../jira-client.ts";
import { decorateTracker } from "./decorator.ts";
import type { Issue, TrackerAdapter, TrackerState } from "./types.ts";

type JiraStatuses = Record<TrackerState, string>;

type JiraTrackerOptions = {
	project: string;
	repo: string;
	baseUrl: string;
	statuses: JiraStatuses;
};

function issueKey(project: string, issueNumber: number): string {
	return `${project}-${issueNumber}`;
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
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record["text"] === "string") return record["text"];
		if (Array.isArray(record["content"])) return extractText(record["content"]);
	}
	return "";
}

function parseJiraKey(project: string, key: string): number {
	const match = /^([A-Z][A-Z0-9_]*)-(\d+)$/.exec(key);
	const matchedProject = match?.[1];
	const matchedNumber = match?.[2];
	if (!matchedProject || !matchedNumber || matchedProject !== project) {
		throw new Error(`Invalid Jira issue key: ${key}`);
	}
	return Number.parseInt(matchedNumber, 10);
}

function mapJiraIssue(
	project: string,
	baseUrl: string,
	issue: JiraIssue,
): Issue {
	return {
		key: issue.key,
		number: parseJiraKey(project, issue.key),
		title: issue.fields.summary,
		description: extractText(issue.fields.description),
		labels: [issue.fields.status.name],
		url: `${trimTrailingSlash(baseUrl)}/browse/${issue.key}`,
		createdAt: issue.fields.created,
	};
}

export function jiraTrackerAdapter(
	client: JiraClient,
	options: JiraTrackerOptions,
): TrackerAdapter {
	return decorateTracker({
		async fetchIssue(_repo: string, issueNumber: number): Promise<Issue> {
			const issue = await client.getIssue(
				issueKey(options.project, issueNumber),
			);
			return mapJiraIssue(options.project, options.baseUrl, issue);
		},

		async fetchActiveIssues(
			_repo: string,
			state: TrackerState,
		): Promise<Issue[]> {
			const filter = [
				`project = ${quoteJqlString(options.project)}`,
				`status = ${quoteJqlString(options.statuses[state])}`,
			].join(" AND ");
			const jql = `${filter} ORDER BY created ASC`;
			const issues = await client.searchIssues({ jql, maxResults: 100 });
			return issues.map((issue) =>
				mapJiraIssue(options.project, options.baseUrl, issue),
			);
		},

		async transitionState(
			_repo: string,
			issueNumber: number,
			_from: TrackerState,
			to: TrackerState,
		): Promise<void> {
			const key = issueKey(options.project, issueNumber);
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

		parseIssueKey(key: string): { repo: string; number: number } {
			return {
				repo: options.repo,
				number: parseJiraKey(options.project, key),
			};
		},
	});
}
