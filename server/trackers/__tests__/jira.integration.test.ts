import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createJiraClient } from "../../jira-client.ts";
import {
	createJiraIssue,
	JIRA_API,
	JIRA_BASE_URL,
	REPO,
} from "../../testing/support/fixtures.ts";
import { server } from "../../testing/support/msw.ts";
import { issueNumber, type RepoSlug, repoSlug } from "../../types/brands.ts";
import { jiraTrackerAdapter } from "../jira.ts";

const statuses = {
	pending: "To Do",
	running: "In Progress",
	awaiting_review: "In Review",
} as const;

function createTracker(scopes: readonly RepoSlug[] = [REPO]) {
	return jiraTrackerAdapter(
		createJiraClient({
			baseUrl: JIRA_BASE_URL,
			email: "agent@example.test",
			apiToken: "jira-token",
			maxAttempts: 1,
		}),
		{
			project: "PROJ",
			scopes,
			baseUrl: JIRA_BASE_URL,
			statuses,
			triggerLabel: "agent",
		},
	);
}

describe("jiraTrackerAdapter", () => {
	describe("fetchActiveIssues", () => {
		it("builds JQL constrained by project, status, trigger label, and the authenticated reporter", async () => {
			const expectedFields = [
				"summary",
				"description",
				"status",
				"created",
				"labels",
			];

			server.use(
				http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
					const body = (await request.json()) as Record<string, unknown>;
					if (
						body["jql"] !==
							'project = "PROJ" AND status = "To Do" AND labels = "agent" AND reporter = currentUser() ORDER BY created ASC' ||
						body["maxResults"] !== 100 ||
						JSON.stringify(body["fields"]) !== JSON.stringify(expectedFields)
					) {
						return new HttpResponse(null, { status: 400 });
					}
					return HttpResponse.json({
						issues: [
							createJiraIssue("PROJ-1", "To Do", undefined, [`repo:${REPO}`]),
						],
					});
				}),
			);

			const tracker = createTracker();
			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1"]);
			expect(issues.map((issue) => issue.repo)).toEqual([REPO]);
		});

		it("interpolates a custom trigger label into the JQL labels clause", async () => {
			let capturedJql = "";
			server.use(
				http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
					const body = (await request.json()) as Record<string, unknown>;
					capturedJql = String(body["jql"]);
					return HttpResponse.json({ issues: [] });
				}),
			);

			const tracker = jiraTrackerAdapter(
				createJiraClient({
					baseUrl: JIRA_BASE_URL,
					email: "agent@example.test",
					apiToken: "jira-token",
					maxAttempts: 1,
				}),
				{
					project: "PROJ",
					scopes: [REPO],
					baseUrl: JIRA_BASE_URL,
					statuses,
					triggerLabel: "local-agents",
				},
			);
			await tracker.fetchActiveIssues("pending");

			expect(capturedJql).toBe(
				'project = "PROJ" AND status = "To Do" AND labels = "local-agents" AND reporter = currentUser() ORDER BY created ASC',
			);
		});

		it("maps Issue.labels from fields.labels, not the status name", async () => {
			server.use(
				http.post(`${JIRA_API}/search/jql`, () =>
					HttpResponse.json({
						issues: [
							createJiraIssue("PROJ-2", "To Do", undefined, [
								`repo:${REPO}`,
								"needs-triage",
							]),
						],
					}),
				),
			);

			const tracker = createTracker();
			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues).toHaveLength(1);
			expect(issues[0]?.labels).toEqual([`repo:${REPO}`, "needs-triage"]);
		});

		it("dispatches when an issue has a single matching repo: label", async () => {
			server.use(
				http.post(`${JIRA_API}/search/jql`, () =>
					HttpResponse.json({
						issues: [
							createJiraIssue("PROJ-3", "To Do", undefined, [`repo:${REPO}`]),
						],
					}),
				),
			);

			const tracker = createTracker();
			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues.map((i) => i.key)).toEqual(["PROJ-3"]);
			expect(issues.map((i) => i.repo)).toEqual([REPO]);
		});

		it("drops issues with no repo: label", async () => {
			server.use(
				http.post(`${JIRA_API}/search/jql`, () =>
					HttpResponse.json({
						issues: [createJiraIssue("PROJ-4", "To Do", undefined, [])],
					}),
				),
			);

			const tracker = createTracker();
			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues).toEqual([]);
		});

		it("drops issues whose repo: label does not resolve against any scope", async () => {
			server.use(
				http.post(`${JIRA_API}/search/jql`, () =>
					HttpResponse.json({
						issues: [
							createJiraIssue("PROJ-5", "To Do", undefined, [
								"repo:other-org/somewhere-else",
							]),
						],
					}),
				),
			);

			const tracker = createTracker();
			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues).toEqual([]);
		});

		it("drops issues with multiple repo: labels", async () => {
			const REPO_B = repoSlug("test-owner/repo-b");
			server.use(
				http.post(`${JIRA_API}/search/jql`, () =>
					HttpResponse.json({
						issues: [
							createJiraIssue("PROJ-6", "To Do", undefined, [
								`repo:${REPO}`,
								`repo:${REPO_B}`,
							]),
						],
					}),
				),
			);

			const tracker = createTracker([REPO, REPO_B]);
			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues).toEqual([]);
		});

		it("resolves a repo: label that descends from a group-prefix scope to its full path", async () => {
			const childRepo = repoSlug("test-owner/playground/child");
			server.use(
				http.post(`${JIRA_API}/search/jql`, () =>
					HttpResponse.json({
						issues: [
							createJiraIssue("PROJ-7", "To Do", undefined, [
								`repo:${childRepo}`,
							]),
						],
					}),
				),
			);

			const tracker = createTracker([repoSlug("test-owner")]);
			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues.map((i) => i.repo)).toEqual([childRepo]);
		});

		it("escapes quotes and backslashes in custom status names", async () => {
			server.use(
				http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
					const body = (await request.json()) as { jql?: string };
					if (
						body.jql !==
						'project = "PROJ" AND status = "Ready \\"Now\\" \\\\ Backlog" AND labels = "agent" AND reporter = currentUser() ORDER BY created ASC'
					) {
						return new HttpResponse(null, { status: 400 });
					}
					return HttpResponse.json({ issues: [] });
				}),
			);

			const tracker = jiraTrackerAdapter(
				createJiraClient({
					baseUrl: JIRA_BASE_URL,
					email: "agent@example.test",
					apiToken: "jira-token",
					maxAttempts: 1,
				}),
				{
					project: "PROJ",
					scopes: [REPO],
					baseUrl: JIRA_BASE_URL,
					statuses: {
						...statuses,
						pending: 'Ready "Now" \\ Backlog',
					},
					triggerLabel: "agent",
				},
			);

			const { issues } = await tracker.fetchActiveIssues("pending");
			expect(issues).toEqual([]);
		});
	});

	describe("transitionState", () => {
		it("resolves and posts the transition whose target status matches the logical state", async () => {
			server.use(
				http.get(`${JIRA_API}/issue/:key/transitions`, ({ params }) => {
					if (params["key"] !== "PROJ-42") {
						return new HttpResponse(null, { status: 400 });
					}
					return HttpResponse.json({
						transitions: [
							{ id: "11", name: "Start", to: { name: "In Progress" } },
							{ id: "21", name: "Review", to: { name: "In Review" } },
						],
					});
				}),
				http.post(`${JIRA_API}/issue/:key/transitions`, async ({ request }) => {
					const body = await request.json();
					if (
						JSON.stringify(body) !==
						JSON.stringify({ transition: { id: "21" } })
					) {
						return new HttpResponse(null, { status: 400 });
					}
					return new HttpResponse(null, { status: 204 });
				}),
			);

			const tracker = createTracker();

			await expect(
				tracker.transitionState(
					REPO,
					issueNumber(42),
					"running",
					"awaiting_review",
				),
			).resolves.toBeUndefined();
		});

		it("matches transition target status case-insensitively", async () => {
			server.use(
				http.get(`${JIRA_API}/issue/:key/transitions`, () =>
					HttpResponse.json({
						transitions: [
							{ id: "11", name: "Start", to: { name: "In Progress" } },
						],
					}),
				),
				http.post(`${JIRA_API}/issue/:key/transitions`, async ({ request }) => {
					const body = await request.json();
					if (
						JSON.stringify(body) !==
						JSON.stringify({ transition: { id: "11" } })
					) {
						return new HttpResponse(null, { status: 400 });
					}
					return new HttpResponse(null, { status: 204 });
				}),
			);

			const tracker = jiraTrackerAdapter(
				createJiraClient({
					baseUrl: JIRA_BASE_URL,
					email: "agent@example.test",
					apiToken: "jira-token",
					maxAttempts: 1,
				}),
				{
					project: "PROJ",
					scopes: [REPO],
					baseUrl: JIRA_BASE_URL,
					statuses: {
						...statuses,
						running: "IN PROGRESS",
					},
					triggerLabel: "agent",
				},
			);

			await expect(
				tracker.transitionState(REPO, issueNumber(42), "pending", "running"),
			).resolves.toBeUndefined();
		});

		it("fails when Jira does not expose a transition to the target status", async () => {
			server.use(
				http.get(`${JIRA_API}/issue/:key/transitions`, () =>
					HttpResponse.json({
						transitions: [
							{ id: "11", name: "Start", to: { name: "In Progress" } },
						],
					}),
				),
				http.post(`${JIRA_API}/issue/:key/transitions`, () =>
					HttpResponse.json(null, { status: 400 }),
				),
			);

			const tracker = createTracker();

			await expect(
				tracker.transitionState(
					REPO,
					issueNumber(42),
					"running",
					"awaiting_review",
				),
			).rejects.toThrow("No Jira transition for PROJ-42 to status In Review");
		});
	});

	describe("markFailed", () => {
		it("adds the failed label and removes the trigger label", async () => {
			const captured: { key: string; body: unknown }[] = [];
			server.use(
				http.put(`${JIRA_API}/issue/:key`, async ({ request, params }) => {
					captured.push({
						key: String(params["key"]),
						body: await request.json(),
					});
					return new HttpResponse(null, { status: 204 });
				}),
			);

			const tracker = createTracker();

			await tracker.markFailed(REPO, issueNumber(42));

			expect(captured).toEqual([
				{
					key: "PROJ-42",
					body: {
						update: {
							labels: [{ add: "agent-failed" }, { remove: "agent" }],
						},
					},
				},
			]);
		});
	});
});
