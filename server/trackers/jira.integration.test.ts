import { FetchHttpClient } from "@effect/platform";
import { layer } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { HttpResponse, http } from "msw";
import { describe, expect } from "vitest";
import {
	createJiraIssue,
	JIRA_API,
	JIRA_BASE_URL,
	REPO,
} from "../test-support/fixtures.ts";
import { server } from "../test-support/msw.ts";
import { JiraTransitionNotFoundError } from "./errors.ts";
import { createJiraTracker, type JiraTrackerOptions } from "./jira-tracker.ts";

layer(FetchHttpClient.layer)("Jira tracker", (it) => {
	describe("fetchActiveIssues", () => {
		it.effect(
			"sends the correct JQL, fields, and maxResults to the search endpoint",
			() =>
				Effect.gen(function* () {
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
								JSON.stringify(body["fields"]) !==
									JSON.stringify(expectedFields)
							) {
								return new HttpResponse(null, { status: 400 });
							}
							return HttpResponse.json({
								issues: [
									createJiraIssue("PROJ-1", "To Do", undefined, [
										`repo:${REPO}`,
									]),
								],
							});
						}),
					);

					const tracker = yield* createJiraTracker(defaultOptions);
					const { issues } = yield* tracker.fetchActiveIssues("pending");

					expect(issues.map((issue) => issue.key)).toEqual(["PROJ-1"]);
					expect(issues.map((issue) => issue.repo)).toEqual([REPO]);
				}),
		);
	});

	describe("transitionState", () => {
		it.effect(
			"resolves and posts the transition whose target status matches the logical state",
			() =>
				Effect.gen(function* () {
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
						http.post(
							`${JIRA_API}/issue/:key/transitions`,
							async ({ request }) => {
								const body = await request.json();
								if (
									JSON.stringify(body) !==
									JSON.stringify({ transition: { id: "21" } })
								) {
									return new HttpResponse(null, { status: 400 });
								}
								return new HttpResponse(null, { status: 204 });
							},
						),
					);

					const tracker = yield* createJiraTracker(defaultOptions);
					yield* tracker.transitionState(
						REPO,
						42,
						"running",
						"awaiting_review",
					);
				}),
		);

		it.effect("matches transition target status case-insensitively", () =>
			Effect.gen(function* () {
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
					http.post(
						`${JIRA_API}/issue/:key/transitions`,
						async ({ request }) => {
							const body = await request.json();
							if (
								JSON.stringify(body) !==
								JSON.stringify({ transition: { id: "11" } })
							) {
								return new HttpResponse(null, { status: 400 });
							}
							return new HttpResponse(null, { status: 204 });
						},
					),
				);

				const tracker = yield* createJiraTracker({
					...defaultOptions,
					statuses: {
						...statuses,
						running: "IN PROGRESS",
					},
				});

				yield* tracker.transitionState(REPO, 42, "pending", "running");
			}),
		);

		it.effect(
			"assigns the issue to the authenticated user before posting the transition",
			() =>
				Effect.gen(function* () {
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

					const tracker = yield* createJiraTracker(defaultOptions);
					yield* tracker.transitionState(REPO, 42, "pending", "running");

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
				}),
		);

		it.effect(
			"does not assign or fetch the authenticated user when transitioning out of running",
			() =>
				Effect.gen(function* () {
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

					const tracker = yield* createJiraTracker(defaultOptions);
					yield* tracker.transitionState(
						REPO,
						42,
						"running",
						"awaiting_review",
					);

					expect(myselfCalled).toBe(false);
					expect(assignCalled).toBe(false);
				}),
		);

		it.effect(
			"does not post the transition when fetching the authenticated user fails",
			() =>
				Effect.gen(function* () {
					let transitionPosts = 0;
					server.use(
						http.get(
							`${JIRA_API}/myself`,
							() => new HttpResponse(null, { status: 403 }),
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

					const tracker = yield* createJiraTracker(defaultOptions);
					const exit = yield* tracker
						.transitionState(REPO, 42, "pending", "running")
						.pipe(Effect.exit);

					expect(Exit.isFailure(exit)).toBe(true);
					expect(transitionPosts).toBe(0);
				}),
		);

		it.effect(
			"fails when Jira does not expose a transition to the target status",
			() =>
				Effect.gen(function* () {
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

					const tracker = yield* createJiraTracker(defaultOptions);
					const exit = yield* tracker
						.transitionState(REPO, 42, "running", "awaiting_review")
						.pipe(Effect.exit);

					expect(exit).toEqual(
						Exit.fail(
							new JiraTransitionNotFoundError({
								issueKey: "PROJ-42",
								targetStatus: "In Review",
							}),
						),
					);
				}),
		);
	});

	describe("markFailed", () => {
		it.effect("adds the failed label and removes the trigger label", () =>
			Effect.gen(function* () {
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

				const tracker = yield* createJiraTracker(defaultOptions);
				yield* tracker.markFailed(REPO, 42);

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
			}),
		);
	});
});

const statuses = {
	pending: "To Do",
	running: "In Progress",
	awaiting_review: "In Review",
} as const;

const defaultOptions: JiraTrackerOptions = {
	project: "PROJ",
	scopes: [REPO],
	baseUrl: JIRA_BASE_URL,
	statuses,
	triggerLabel: "agent",
	email: "agent@example.test",
	apiToken: "jira-token",
};
