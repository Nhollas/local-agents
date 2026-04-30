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
import { jiraTrackerAdapter } from "../jira.ts";

const statuses = {
	pending: "To Do",
	running: "In Progress",
	awaiting_review: "In Review",
} as const;

function createTracker() {
	return jiraTrackerAdapter(
		createJiraClient({
			baseUrl: JIRA_BASE_URL,
			email: "agent@example.test",
			apiToken: "jira-token",
			maxAttempts: 1,
		}),
		{
			project: "PROJ",
			repo: REPO,
			baseUrl: JIRA_BASE_URL,
			statuses,
		},
	);
}

describe("jiraTrackerAdapter", () => {
	describe("fetchIssue", () => {
		it("maps Jira issues to tracker issues", async () => {
			server.use(
				http.get(`${JIRA_API}/issue/:key`, ({ request, params }) => {
					expect(params["key"]).toBe("PROJ-42");
					expect(request.headers.get("Authorization")).toBe(
						`Basic ${Buffer.from("agent@example.test:jira-token").toString("base64")}`,
					);
					return HttpResponse.json(createJiraIssue("PROJ-42", "To Do"));
				}),
			);

			const tracker = createTracker();

			await expect(tracker.fetchIssue(REPO, 42)).resolves.toEqual({
				key: "PROJ-42",
				number: 42,
				title: "Issue PROJ-42",
				description: "Description for PROJ-42",
				labels: ["To Do"],
				url: `${JIRA_BASE_URL}/browse/PROJ-42`,
				createdAt: "2025-01-01T00:00:00.000+0000",
			});
		});

		it("maps null descriptions to empty strings", async () => {
			server.use(
				http.get(`${JIRA_API}/issue/:key`, () =>
					HttpResponse.json({
						...createJiraIssue("PROJ-7", "To Do"),
						fields: {
							...createJiraIssue("PROJ-7", "To Do").fields,
							description: null,
						},
					}),
				),
			);

			const tracker = createTracker();
			const issue = await tracker.fetchIssue(REPO, 7);

			expect(issue.description).toBe("");
		});

		it("maps plain string descriptions", async () => {
			server.use(
				http.get(`${JIRA_API}/issue/:key`, () =>
					HttpResponse.json({
						...createJiraIssue("PROJ-8", "To Do"),
						fields: {
							...createJiraIssue("PROJ-8", "To Do").fields,
							description: "Plain description",
						},
					}),
				),
			);

			const tracker = createTracker();
			const issue = await tracker.fetchIssue(REPO, 8);

			expect(issue.description).toBe("Plain description");
		});

		it("maps unsupported object descriptions to empty strings", async () => {
			server.use(
				http.get(`${JIRA_API}/issue/:key`, () =>
					HttpResponse.json({
						...createJiraIssue("PROJ-9", "To Do"),
						fields: {
							...createJiraIssue("PROJ-9", "To Do").fields,
							description: { type: "unknown" },
						},
					}),
				),
			);

			const tracker = createTracker();
			const issue = await tracker.fetchIssue(REPO, 9);

			expect(issue.description).toBe("");
		});
	});

	describe("fetchActiveIssues", () => {
		it("builds safe JQL for the configured project and logical status", async () => {
			let capturedJql = "";

			server.use(
				http.get(`${JIRA_API}/search`, ({ request }) => {
					const url = new URL(request.url);
					capturedJql = url.searchParams.get("jql") ?? "";
					expect(url.searchParams.get("maxResults")).toBe("100");
					expect(url.searchParams.get("fields")).toBe(
						"summary,description,status,created",
					);
					return HttpResponse.json({
						issues: [createJiraIssue("PROJ-1", "To Do")],
					});
				}),
			);

			const tracker = createTracker();
			const issues = await tracker.fetchActiveIssues(REPO, "pending");

			expect(capturedJql).toBe(
				'project = "PROJ" AND status = "To Do" ORDER BY created ASC',
			);
			expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1"]);
		});

		it("escapes quotes and backslashes in custom status names", async () => {
			let capturedJql = "";

			server.use(
				http.get(`${JIRA_API}/search`, ({ request }) => {
					capturedJql = new URL(request.url).searchParams.get("jql") ?? "";
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
					repo: REPO,
					baseUrl: JIRA_BASE_URL,
					statuses: {
						...statuses,
						pending: 'Ready "Now" \\ Backlog',
					},
				},
			);

			await tracker.fetchActiveIssues(REPO, "pending");

			expect(capturedJql).toBe(
				'project = "PROJ" AND status = "Ready \\"Now\\" \\\\ Backlog" ORDER BY created ASC',
			);
		});
	});

	describe("transitionState", () => {
		it("resolves and posts the transition whose target status matches the logical state", async () => {
			let postedBody: unknown;

			server.use(
				http.get(`${JIRA_API}/issue/:key/transitions`, ({ params }) => {
					expect(params["key"]).toBe("PROJ-42");
					return HttpResponse.json({
						transitions: [
							{ id: "11", name: "Start", to: { name: "In Progress" } },
							{ id: "21", name: "Review", to: { name: "In Review" } },
						],
					});
				}),
				http.post(`${JIRA_API}/issue/:key/transitions`, async ({ request }) => {
					postedBody = await request.json();
					return new HttpResponse(null, { status: 204 });
				}),
			);

			const tracker = createTracker();
			await tracker.transitionState(REPO, 42, "running", "awaiting_review");

			expect(postedBody).toEqual({ transition: { id: "21" } });
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
				tracker.transitionState(REPO, 42, "running", "awaiting_review"),
			).rejects.toThrow("No Jira transition for PROJ-42 to status In Review");
		});
	});

	describe("parseIssueKey", () => {
		it("parses native Jira issue keys to the configured code-host repo", () => {
			const tracker = createTracker();

			expect(tracker.parseIssueKey("PROJ-42")).toEqual({
				repo: REPO,
				number: 42,
			});
		});

		it("rejects malformed Jira issue keys", () => {
			const tracker = createTracker();

			expect(() => tracker.parseIssueKey("PROJ#42")).toThrow(
				"Invalid Jira issue key",
			);
			expect(() => tracker.parseIssueKey("OTHER-42")).toThrow(
				"Invalid Jira issue key",
			);
		});
	});
});
