import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
	createJiraIssue,
	JIRA_API,
	JIRA_BASE_URL,
} from "../test-support/fixtures.ts";
import { server } from "../test-support/msw.ts";
import { createJiraClient } from "./jira-client.ts";

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
			email: "agent@example.test",
			apiToken: "jira-token",
			maxAttempts: 1,
		});

		const issues = await client.searchIssues({ jql: 'project = "PROJ"' });

		expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1"]);
	});

	describe("updateLabels", () => {
		it("PUTs an add+remove label update for the issue", async () => {
			const captured: { method: string; key: string; body: unknown }[] = [];
			server.use(
				http.put(`${JIRA_API}/issue/:key`, async ({ request, params }) => {
					captured.push({
						method: request.method,
						key: String(params["key"]),
						body: await request.json(),
					});
					return new HttpResponse(null, { status: 204 });
				}),
			);

			const client = createJiraClient({
				baseUrl: JIRA_BASE_URL,
				email: "agent@example.test",
				apiToken: "jira-token",
				maxAttempts: 1,
			});

			await client.updateLabels("PROJ-7", {
				add: ["agent-failed"],
				remove: ["agent"],
			});

			expect(captured).toEqual([
				{
					method: "PUT",
					key: "PROJ-7",
					body: {
						update: {
							labels: [{ add: "agent-failed" }, { remove: "agent" }],
						},
					},
				},
			]);
		});

		it("does not call Jira when there are no add or remove ops", async () => {
			let called = false;
			server.use(
				http.put(`${JIRA_API}/issue/:key`, () => {
					called = true;
					return new HttpResponse(null, { status: 204 });
				}),
			);

			const client = createJiraClient({
				baseUrl: JIRA_BASE_URL,
				email: "agent@example.test",
				apiToken: "jira-token",
				maxAttempts: 1,
			});

			await client.updateLabels("PROJ-7", {});

			expect(called).toBe(false);
		});
	});

	describe("getMyself", () => {
		it("GETs /myself and returns the accountId", async () => {
			server.use(
				http.get(`${JIRA_API}/myself`, () =>
					HttpResponse.json({
						accountId: "acct-123",
						displayName: "Agent Runner",
						emailAddress: "agent@example.test",
					}),
				),
			);

			const client = createJiraClient({
				baseUrl: JIRA_BASE_URL,
				email: "agent@example.test",
				apiToken: "jira-token",
				maxAttempts: 1,
			});

			const me = await client.getMyself();

			expect(me).toEqual({ accountId: "acct-123" });
		});

		it("caches the result across repeat calls", async () => {
			let calls = 0;
			server.use(
				http.get(`${JIRA_API}/myself`, () => {
					calls += 1;
					return HttpResponse.json({ accountId: "acct-123" });
				}),
			);

			const client = createJiraClient({
				baseUrl: JIRA_BASE_URL,
				email: "agent@example.test",
				apiToken: "jira-token",
				maxAttempts: 1,
			});

			await client.getMyself();
			await client.getMyself();

			expect(calls).toBe(1);
		});

		it("re-fetches after a failed call", async () => {
			let calls = 0;
			server.use(
				http.get(`${JIRA_API}/myself`, () => {
					calls += 1;
					if (calls === 1) return new HttpResponse(null, { status: 500 });
					return HttpResponse.json({ accountId: "acct-123" });
				}),
			);

			const client = createJiraClient({
				baseUrl: JIRA_BASE_URL,
				email: "agent@example.test",
				apiToken: "jira-token",
				maxAttempts: 1,
			});

			await expect(client.getMyself()).rejects.toThrow();
			const me = await client.getMyself();

			expect(me).toEqual({ accountId: "acct-123" });
			expect(calls).toBe(2);
		});
	});

	describe("assignIssue", () => {
		it("PUTs the assignee accountId for the issue", async () => {
			const captured: { key: string; body: unknown }[] = [];
			server.use(
				http.put(
					`${JIRA_API}/issue/:key/assignee`,
					async ({ request, params }) => {
						captured.push({
							key: String(params["key"]),
							body: await request.json(),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
			);

			const client = createJiraClient({
				baseUrl: JIRA_BASE_URL,
				email: "agent@example.test",
				apiToken: "jira-token",
				maxAttempts: 1,
			});

			await client.assignIssue("PROJ-7", "acct-123");

			expect(captured).toEqual([
				{ key: "PROJ-7", body: { accountId: "acct-123" } },
			]);
		});
	});
});
