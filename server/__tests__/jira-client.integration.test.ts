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
		let capturedMaxResults = "";

		server.use(
			http.get(`${JIRA_API}/search`, ({ request }) => {
				capturedMaxResults =
					new URL(request.url).searchParams.get("maxResults") ?? "";
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

		expect(capturedMaxResults).toBe("100");
		expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1"]);
	});
});
