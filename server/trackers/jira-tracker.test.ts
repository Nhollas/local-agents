import { describe, expect, it } from "vitest";
import { buildJql, resolveJiraIssue } from "./jira-tracker.ts";
import type { JiraIssue } from "./schemas.ts";

describe("buildJql", () => {
	it("constrains by project, status, trigger label, and authenticated reporter", () => {
		expect(
			buildJql(
				{
					project: "PROJ",
					statuses: {
						pending: "To Do",
						running: "In Progress",
						awaiting_review: "In Review",
					},
					triggerLabel: "agent",
				},
				"pending",
			),
		).toBe(
			'project = "PROJ" AND status = "To Do" AND labels = "agent" AND reporter = currentUser() ORDER BY created ASC',
		);
	});

	it("interpolates a custom trigger label", () => {
		expect(
			buildJql(
				{
					project: "PROJ",
					statuses: {
						pending: "To Do",
						running: "In Progress",
						awaiting_review: "In Review",
					},
					triggerLabel: "local-agents",
				},
				"pending",
			),
		).toBe(
			'project = "PROJ" AND status = "To Do" AND labels = "local-agents" AND reporter = currentUser() ORDER BY created ASC',
		);
	});

	it("escapes quotes and backslashes in status names", () => {
		expect(
			buildJql(
				{
					project: "PROJ",
					statuses: {
						pending: 'Ready "Now" \\ Backlog',
						running: "In Progress",
						awaiting_review: "In Review",
					},
					triggerLabel: "agent",
				},
				"pending",
			),
		).toBe(
			'project = "PROJ" AND status = "Ready \\"Now\\" \\\\ Backlog" AND labels = "agent" AND reporter = currentUser() ORDER BY created ASC',
		);
	});
});

describe("resolveJiraIssue", () => {
	it("resolves when an issue has a single matching repo: label", () => {
		expect(
			resolveJiraIssue(jiraIssue("PROJ-1", [`repo:${REPO}`]), [REPO], BASE_URL),
		).toEqual({
			_tag: "resolved",
			issue: {
				key: "PROJ-1",
				number: 1,
				repo: REPO,
				title: "Issue PROJ-1",
				description: "Description for PROJ-1",
				labels: [`repo:${REPO}`],
				url: `${BASE_URL}/browse/PROJ-1`,
				createdAt: "2025-01-01T00:00:00.000+0000",
			},
		});
	});

	it("preserves all labels on the resolved issue", () => {
		const result = resolveJiraIssue(
			jiraIssue("PROJ-2", [`repo:${REPO}`, "needs-triage"]),
			[REPO],
			BASE_URL,
		);
		expect(result._tag).toBe("resolved");
		expect(result._tag === "resolved" && result.issue.labels).toEqual([
			`repo:${REPO}`,
			"needs-triage",
		]);
	});

	it("drops issues with no repo: label", () => {
		expect(resolveJiraIssue(jiraIssue("PROJ-3", []), [REPO], BASE_URL)).toEqual(
			{ _tag: "dropped", reason: "no_repo_label" },
		);
	});

	it("drops issues whose repo: label does not resolve against any scope", () => {
		expect(
			resolveJiraIssue(
				jiraIssue("PROJ-4", ["repo:other-org/somewhere-else"]),
				[REPO],
				BASE_URL,
			),
		).toEqual({ _tag: "dropped", reason: "unresolved_repo_label" });
	});

	it("drops issues with multiple repo: labels", () => {
		const REPO_B = "test-owner/repo-b";
		expect(
			resolveJiraIssue(
				jiraIssue("PROJ-5", [`repo:${REPO}`, `repo:${REPO_B}`]),
				[REPO, REPO_B],
				BASE_URL,
			),
		).toEqual({ _tag: "dropped", reason: "multiple_repo_labels" });
	});

	it("resolves a repo: label that descends from a group-prefix scope", () => {
		const childRepo = "test-owner/playground/child";
		const result = resolveJiraIssue(
			jiraIssue("PROJ-6", [`repo:${childRepo}`]),
			["test-owner"],
			BASE_URL,
		);
		expect(result._tag).toBe("resolved");
		expect(result._tag === "resolved" && result.issue.repo).toBe(childRepo);
	});

	it("uses null for description when the field is absent", () => {
		const result = resolveJiraIssue(
			jiraIssue("PROJ-7", [`repo:${REPO}`], { description: undefined }),
			[REPO],
			BASE_URL,
		);
		expect(result._tag === "resolved" && result.issue.description).toBe("");
	});
});

const BASE_URL = "https://jira.example.test";
const REPO = "test-owner/test-repo";

function jiraIssue(
	key: string,
	labels: string[],
	overrides?: Partial<JiraIssue["fields"]>,
): JiraIssue {
	const number = Number.parseInt(key.slice(key.indexOf("-") + 1), 10);
	return {
		key: { raw: key, number },
		fields: {
			summary: `Issue ${key}`,
			description: `Description for ${key}`,
			created: "2025-01-01T00:00:00.000+0000",
			labels,
			status: { name: "To Do" },
			...overrides,
		},
	};
}
