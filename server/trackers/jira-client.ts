import { HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import type { HttpClientError } from "../http/errors.ts";
import {
	parseResponseBody,
	platformHttpClient,
} from "../http/platform-client.ts";
import {
	type JiraIssue,
	JiraIssueSchema,
	JiraMyselfSchema,
	JiraSearchSchema,
	JiraTransitionsSchema,
} from "./schemas.ts";

type JiraClientOptions = {
	readonly baseUrl: string;
	readonly email: string;
	readonly apiToken: string;
};

export const jiraClient = (options: JiraClientOptions) =>
	Effect.gen(function* () {
		const authHeader = `Basic ${basicAuth(options.email, options.apiToken)}`;

		const { http, instrument } = yield* platformHttpClient({
			service: "jira",
			baseUrl: `${options.baseUrl}/rest/api/2`,
			mapRequest: (req) =>
				req.pipe(
					HttpClientRequest.setHeader("Authorization", authHeader),
					HttpClientRequest.acceptJson,
				),
		});

		const getIssue = (
			key: string,
		): Effect.Effect<JiraIssue, HttpClientError> => {
			const query = new URLSearchParams({ fields: ISSUE_FIELDS.join(",") });
			return http
				.execute(
					HttpClientRequest.get(`/issue/${encodeIssueKey(key)}?${query}`),
				)
				.pipe(
					parseResponseBody(JiraIssueSchema),
					instrument("getIssue", { "jira.issue.key": key }),
				);
		};

		const searchIssues = (params: {
			readonly jql: string;
			readonly maxResults?: number;
		}): Effect.Effect<ReadonlyArray<JiraIssue>, HttpClientError> =>
			http
				.execute(
					HttpClientRequest.post("/search/jql").pipe(
						HttpClientRequest.bodyUnsafeJson({
							jql: params.jql,
							maxResults: params.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
							fields: [...ISSUE_FIELDS],
						}),
					),
				)
				.pipe(
					parseResponseBody(JiraSearchSchema),
					Effect.map((result) => result.issues),
					instrument("searchIssues", { "jira.jql": params.jql }),
				);

		const listTransitions = (
			key: string,
		): Effect.Effect<
			ReadonlyArray<{
				id: string;
				name: string;
				to: { name: string };
			}>,
			HttpClientError
		> =>
			http
				.execute(
					HttpClientRequest.get(`/issue/${encodeIssueKey(key)}/transitions`),
				)
				.pipe(
					parseResponseBody(JiraTransitionsSchema),
					Effect.map((result) => result.transitions),
					instrument("listTransitions", { "jira.issue.key": key }),
				);

		const transitionIssue = (
			key: string,
			transitionId: string,
		): Effect.Effect<void, HttpClientError> =>
			http
				.execute(
					HttpClientRequest.post(
						`/issue/${encodeIssueKey(key)}/transitions`,
					).pipe(
						HttpClientRequest.bodyUnsafeJson({
							transition: { id: transitionId },
						}),
					),
				)
				.pipe(
					Effect.asVoid,
					instrument("transitionIssue", {
						"jira.issue.key": key,
						"jira.transition.id": transitionId,
					}),
				);

		const updateLabels = (
			key: string,
			changes: {
				readonly add?: readonly string[];
				readonly remove?: readonly string[];
			},
		): Effect.Effect<void, HttpClientError> => {
			const ops: Array<{ add: string } | { remove: string }> = [
				...(changes.add ?? []).map((label) => ({ add: label })),
				...(changes.remove ?? []).map((label) => ({ remove: label })),
			];
			if (ops.length === 0) return Effect.void;
			return http
				.execute(
					HttpClientRequest.put(`/issue/${encodeIssueKey(key)}`).pipe(
						HttpClientRequest.bodyUnsafeJson({ update: { labels: ops } }),
					),
				)
				.pipe(
					Effect.asVoid,
					instrument("updateLabels", {
						"jira.issue.key": key,
						"jira.labels.add": (changes.add ?? []).join(","),
						"jira.labels.remove": (changes.remove ?? []).join(","),
					}),
				);
		};

		const getMyself = (): Effect.Effect<
			{ accountId: string },
			HttpClientError
		> =>
			http
				.execute(HttpClientRequest.get("/myself"))
				.pipe(parseResponseBody(JiraMyselfSchema), instrument("getMyself", {}));

		const assignIssue = (
			key: string,
			accountId: string,
		): Effect.Effect<void, HttpClientError> =>
			http
				.execute(
					HttpClientRequest.put(`/issue/${encodeIssueKey(key)}/assignee`).pipe(
						HttpClientRequest.bodyUnsafeJson({ accountId }),
					),
				)
				.pipe(
					Effect.asVoid,
					instrument("assignIssue", {
						"jira.issue.key": key,
						"jira.assignee.account_id": accountId,
					}),
				);

		return {
			getIssue,
			searchIssues,
			listTransitions,
			transitionIssue,
			updateLabels,
			getMyself,
			assignIssue,
		};
	});

const ISSUE_FIELDS = [
	"summary",
	"description",
	"status",
	"created",
	"labels",
] as const;
const DEFAULT_SEARCH_MAX_RESULTS = 100;

function encodeIssueKey(key: string): string {
	return encodeURIComponent(key);
}

function basicAuth(email: string, apiToken: string): string {
	return Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
}
