import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createJiraClient } from "../jira-client.ts";
import {
	createJiraIssue,
	JIRA_API,
	JIRA_BASE_URL,
} from "../testing/support/fixtures.ts";
import { server } from "../testing/support/msw.ts";

describe("Jira client", () => {
	it("defaults search maxResults to 100", async () => {
		let capturedBody: unknown;

		server.use(
			http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
				capturedBody = await request.json();
				return HttpResponse.json({
					issues: [createJiraIssue("PROJ-1", "To Do")],
				});
			}),
		);

		const client = createJiraClient({
			baseUrl: JIRA_BASE_URL,
			email: "agent@example.test",
			apiToken: "jira-token",
			maxAttempts: 1,
		});

		const issues = await client.searchIssues({ jql: 'project = "PROJ"' });

		expect(capturedBody).toMatchObject({
			jql: 'project = "PROJ"',
			maxResults: 100,
			fields: ["summary", "description", "status", "created"],
		});
		expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1"]);
	});
});
