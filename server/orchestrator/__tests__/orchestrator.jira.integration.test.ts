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
import { jiraApiToken, jiraEmail } from "../../types/brands.ts";

const statuses = {
	pending: "To Do",
	running: "In Progress",
	awaiting_review: "In Review",
} as const;

describe("Orchestrator Jira dispatch", () => {
	it("maps Jira issues to the single configured code-host repo", async () => {
		// Strict one-shot handlers fire only when the orchestrator posts the
		// expected transition ids in order: 11 (To Do → In Progress) on dispatch,
		// then 21 (→ In Review) after success. We assert via `isUsed` rather than
		// capturing request bodies.
		const startTransition = http.post(
			`${JIRA_API}/issue/:key/transitions`,
			async ({ request }) => {
				const body = (await request.json()) as { transition: { id: string } };
				if (body.transition.id !== "11") {
					return new HttpResponse(null, { status: 400 });
				}
				return new HttpResponse(null, { status: 204 });
			},
			{ once: true },
		);
		const reviewTransition = http.post(
			`${JIRA_API}/issue/:key/transitions`,
			async ({ request }) => {
				const body = (await request.json()) as { transition: { id: string } };
				if (body.transition.id !== "21") {
					return new HttpResponse(null, { status: 400 });
				}
				return new HttpResponse(null, { status: 204 });
			},
			{ once: true },
		);

		server.use(
			http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
				const body = (await request.json()) as { jql?: string };
				const jql = body.jql ?? "";
				if (jql.includes('status = "To Do"')) {
					return HttpResponse.json({
						issues: [
							createJiraIssue("PROJ-42", "To Do", undefined, [`repo:${REPO}`]),
						],
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
			startTransition,
			reviewTransition,
		);

		const tracker = jiraTrackerAdapter(
			createJiraClient({
				baseUrl: JIRA_BASE_URL,
				email: jiraEmail("agent@example.test"),
				apiToken: jiraApiToken("jira-token"),
				maxAttempts: 1,
			}),
			{
				project: "PROJ",
				scopes: [REPO],
				baseUrl: JIRA_BASE_URL,
				statuses,
				triggerLabel: "agent",
			},
		);

		// Strict codeHost stub: returns success only when called against the
		// single configured Jira-mapped repo with the expected close body.
		await using ctx = await createTestOrchestrator({
			tracker: () => tracker,
			codeHost: (defaults) => ({
				...defaults,
				createChangeRequest: async (repo, _head, _base, _title, body) => {
					if (repo !== REPO || body !== "Closes PROJ-42") {
						throw new Error(
							`Unexpected createChangeRequest(${repo}, ..., ${body})`,
						);
					}
					return { number: 1, url: "https://example.test/change/1" };
				},
			}),
			workflow: createTestWorkflow(),
		});
		const { orchestrator, runner, workspace } = ctx;
		await workspace.preCreateWorkspace("PROJ-42");

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(startTransition.isUsed).toBe(true);
		expect(reviewTransition.isUsed).toBe(true);
	});
});
