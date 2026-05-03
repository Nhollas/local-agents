import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createJiraClient } from "../jira-client.ts";
import {
	createJiraIssue,
	JIRA_API,
	JIRA_BASE_URL,
} from "../testing/support/fixtures.ts";
import { server } from "../testing/support/msw.ts";
import { jiraApiToken, jiraEmail } from "../types/brands.ts";

describe("Jira client", () => {
	it("defaults search maxResults to 100", async () => {
		server.use(
			http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
				const body = (await request.json()) as Record<string, unknown>;
				if (
					body["jql"] !== 'project = "PROJ"' ||
					body["maxResults"] !== 100 ||
					JSON.stringify(body["fields"]) !==
						JSON.stringify([
							"summary",
							"description",
							"status",
							"created",
							"labels",
						])
				) {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json({
					issues: [createJiraIssue("PROJ-1", "To Do")],
				});
			}),
		);

		const client = createJiraClient({
			baseUrl: JIRA_BASE_URL,
			email: jiraEmail("agent@example.test"),
			apiToken: jiraApiToken("jira-token"),
			maxAttempts: 1,
		});

		const issues = await client.searchIssues({ jql: 'project = "PROJ"' });

		expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1"]);
	});
});
