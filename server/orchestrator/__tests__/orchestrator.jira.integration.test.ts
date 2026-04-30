import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createJiraClient } from "../../jira-client.ts";
import {
	createJiraIssue,
	createTestWorkflow,
	JIRA_API,
	JIRA_BASE_URL,
	REPO,
} from "../../testing/support/fixtures.ts";
import { server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import { jiraTrackerAdapter } from "../../trackers/jira.ts";

const statuses = {
	pending: "To Do",
	running: "In Progress",
	awaiting_review: "In Review",
} as const;

describe("Orchestrator Jira dispatch", () => {
	it("maps Jira issues to the single configured code-host repo", async () => {
		const changeRequests: { repo: string; body: string }[] = [];
		const transitionTargets: string[] = [];

		server.use(
			http.get(`${JIRA_API}/search`, ({ request }) => {
				const jql = new URL(request.url).searchParams.get("jql") ?? "";
				if (jql.includes('status = "To Do"')) {
					return HttpResponse.json({
						issues: [createJiraIssue("PROJ-42", "To Do")],
					});
				}
				return HttpResponse.json({ issues: [] });
			}),
			http.get(`${JIRA_API}/issue/:key/transitions`, () =>
				HttpResponse.json({
					transitions: [
						{ id: "11", name: "Start", to: { name: "In Progress" } },
						{ id: "21", name: "Review", to: { name: "In Review" } },
					],
				}),
			),
			http.post(`${JIRA_API}/issue/:key/transitions`, async ({ request }) => {
				const body = (await request.json()) as {
					transition: { id: string };
				};
				transitionTargets.push(body.transition.id);
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
			{ project: "PROJ", repo: REPO, baseUrl: JIRA_BASE_URL, statuses },
		);

		await using ctx = await createTestOrchestrator({
			tracker: () => tracker,
			codeHost: (defaults) => ({
				...defaults,
				createChangeRequest: async (repo, _head, _base, _title, body) => {
					changeRequests.push({ repo, body });
					return { number: 1, url: "https://example.test/change/1" };
				},
			}),
			workflows: new Map([[REPO, createTestWorkflow()]]),
		});
		const { orchestrator, runner, workspace } = ctx;
		await workspace.preCreateWorkspace("PROJ-42");

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(changeRequests).toEqual([{ repo: REPO, body: "Closes PROJ-42" }]);
		expect(transitionTargets).toEqual(["11", "21"]);
	});
});
