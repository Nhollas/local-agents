import { Cause } from "effect";
import { HttpResponse, http } from "msw";
import { afterAll, describe, expect, it } from "vitest";
import {
	createJiraIssue,
	JIRA_API,
	JIRA_BASE_URL,
	REPO,
} from "../test-support/fixtures.ts";
import { server } from "../test-support/msw.ts";
import { issueNumber, type RepoSlug, repoSlug } from "../types/brands.ts";
import { JiraTransitionNotFoundError } from "./errors.ts";
import { createJiraTracker, type JiraTrackerOptions } from "./jira-tracker.ts";
import { makeTrackerRuntime } from "./runtime.ts";

const runtime = makeTrackerRuntime();
afterAll(() => runtime.dispose());

const statuses = {
	pending: "To Do",
	running: "In Progress",
	awaiting_review: "In Review",
} as const;

async function makeTracker(options: JiraTrackerOptions) {
	const adapter = await runtime.runPromise(createJiraTracker(options));
	return {
		fetchActiveIssues: (
			...args: Parameters<typeof adapter.fetchActiveIssues>
		) => runtime.runPromise(adapter.fetchActiveIssues(...args)),
		transitionState: (...args: Parameters<typeof adapter.transitionState>) =>
			runtime.runPromise(adapter.transitionState(...args)),
		markFailed: (...args: Parameters<typeof adapter.markFailed>) =>
			runtime.runPromise(adapter.markFailed(...args)),
	};
}

function createTracker(scopes: readonly RepoSlug[] = [REPO]) {
	return makeTracker({
		project: "PROJ",
		scopes,
		baseUrl: JIRA_BASE_URL,
		statuses,
		triggerLabel: "agent",
		email: "agent@example.test",
		apiToken: "jira-token",
	});
}

describe("createJiraTracker", () => {
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

			const tracker = await createTracker();
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

			const tracker = await makeTracker({
				project: "PROJ",
				scopes: [REPO],
				baseUrl: JIRA_BASE_URL,
				statuses,
				triggerLabel: "local-agents",
				email: "agent@example.test",
				apiToken: "jira-token",
			});
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

			const tracker = await createTracker();
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

			const tracker = await createTracker();
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

			const tracker = await createTracker();
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

			const tracker = await createTracker();
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

			const tracker = await createTracker([REPO, REPO_B]);
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

			const tracker = await createTracker([repoSlug("test-owner")]);
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

			const tracker = await makeTracker({
				project: "PROJ",
				scopes: [REPO],
				baseUrl: JIRA_BASE_URL,
				statuses: {
					...statuses,
					pending: 'Ready "Now" \\ Backlog',
				},
				triggerLabel: "agent",
				email: "agent@example.test",
				apiToken: "jira-token",
			});

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

			const tracker = await createTracker();

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
				http.get(`${JIRA_API}/myself`, () =>
					HttpResponse.json({ accountId: "acct-123" }),
				),
				http.put(`${JIRA_API}/issue/:key/assignee`, () =>
					HttpResponse.json(null, { status: 204 }),
				),
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

			const tracker = await makeTracker({
				project: "PROJ",
				scopes: [REPO],
				baseUrl: JIRA_BASE_URL,
				statuses: {
					...statuses,
					running: "IN PROGRESS",
				},
				triggerLabel: "agent",
				email: "agent@example.test",
				apiToken: "jira-token",
			});

			await expect(
				tracker.transitionState(REPO, issueNumber(42), "pending", "running"),
			).resolves.toBeUndefined();
		});

		it("assigns the issue to the authenticated user before posting the transition", async () => {
			const calls: Array<{ kind: string; key: string; body: unknown }> = [];
			server.use(
				http.get(`${JIRA_API}/myself`, () =>
					HttpResponse.json({ accountId: "acct-123" }),
				),
				http.put(
					`${JIRA_API}/issue/:key/assignee`,
					async ({ request, params }) => {
						calls.push({
							kind: "assign",
							key: String(params["key"]),
							body: await request.json(),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
				http.get(`${JIRA_API}/issue/:key/transitions`, () =>
					HttpResponse.json({
						transitions: [
							{ id: "11", name: "Start", to: { name: "In Progress" } },
						],
					}),
				),
				http.post(
					`${JIRA_API}/issue/:key/transitions`,
					async ({ request, params }) => {
						calls.push({
							kind: "transition",
							key: String(params["key"]),
							body: await request.json(),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
			);

			const tracker = await createTracker();

			await tracker.transitionState(
				REPO,
				issueNumber(42),
				"pending",
				"running",
			);

			expect(calls).toEqual([
				{
					kind: "assign",
					key: "PROJ-42",
					body: { accountId: "acct-123" },
				},
				{
					kind: "transition",
					key: "PROJ-42",
					body: { transition: { id: "11" } },
				},
			]);
		});

		it("does not assign or fetch the authenticated user when transitioning out of running", async () => {
			let myselfCalled = false;
			let assignCalled = false;
			server.use(
				http.get(`${JIRA_API}/myself`, () => {
					myselfCalled = true;
					return HttpResponse.json({ accountId: "acct-123" });
				}),
				http.put(`${JIRA_API}/issue/:key/assignee`, () => {
					assignCalled = true;
					return new HttpResponse(null, { status: 204 });
				}),
				http.get(`${JIRA_API}/issue/:key/transitions`, () =>
					HttpResponse.json({
						transitions: [
							{ id: "21", name: "Review", to: { name: "In Review" } },
						],
					}),
				),
				http.post(`${JIRA_API}/issue/:key/transitions`, () =>
					HttpResponse.json(null, { status: 204 }),
				),
			);

			const tracker = await createTracker();

			await tracker.transitionState(
				REPO,
				issueNumber(42),
				"running",
				"awaiting_review",
			);

			expect(myselfCalled).toBe(false);
			expect(assignCalled).toBe(false);
		});

		it("does not post the transition when fetching the authenticated user fails", async () => {
			let transitionPosts = 0;
			server.use(
				http.get(
					`${JIRA_API}/myself`,
					() => new HttpResponse(null, { status: 500 }),
				),
				http.put(`${JIRA_API}/issue/:key/assignee`, () =>
					HttpResponse.json(null, { status: 204 }),
				),
				http.get(`${JIRA_API}/issue/:key/transitions`, () =>
					HttpResponse.json({
						transitions: [
							{ id: "11", name: "Start", to: { name: "In Progress" } },
						],
					}),
				),
				http.post(`${JIRA_API}/issue/:key/transitions`, () => {
					transitionPosts += 1;
					return new HttpResponse(null, { status: 204 });
				}),
			);

			const tracker = await createTracker();

			await expect(
				tracker.transitionState(REPO, issueNumber(42), "pending", "running"),
			).rejects.toThrow();
			expect(transitionPosts).toBe(0);
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

			const tracker = await createTracker();

			const causeSymbol = Symbol.for("effect/Runtime/FiberFailure/Cause");
			const error = (await tracker
				.transitionState(REPO, issueNumber(42), "running", "awaiting_review")
				.then(
					() => null,
					(e: unknown) => e,
				)) as Record<symbol, Cause.Cause<unknown>>;
			const failure = Cause.failureOption(error[causeSymbol]);
			expect(failure._tag).toBe("Some");
			expect(failure._tag === "Some" && failure.value).toEqual(
				new JiraTransitionNotFoundError({
					issueKey: "PROJ-42",
					targetStatus: "In Review",
				}),
			);
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

			const tracker = await createTracker();

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
