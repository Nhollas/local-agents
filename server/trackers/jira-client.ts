import { HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import { makeServiceHttpClient } from "../http/service-client.ts";
import {
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

export const makeJiraClient = (options: JiraClientOptions) =>
	Effect.gen(function* () {
		const apiBase = `${options.baseUrl}/rest/api/2`;
		const authHeader = `Basic ${basicAuth(options.email, options.apiToken)}`;

		const { execute, executeJson } = yield* makeServiceHttpClient({
			service: "jira",
			mapRequest: (req) =>
				req.pipe(
					HttpClientRequest.setHeader("Authorization", authHeader),
					HttpClientRequest.acceptJson,
				),
		});

		return {
			getIssue: (key: string) => {
				const query = new URLSearchParams({ fields: ISSUE_FIELDS.join(",") });
				return executeJson(
					"getIssue",
					HttpClientRequest.get(
						`${apiBase}/issue/${encodeIssueKey(key)}?${query}`,
					),
					JiraIssueSchema,
				).pipe(Effect.annotateLogs({ "jira.issue.key": key }));
			},

			searchIssues: (params: {
				readonly jql: string;
				readonly maxResults?: number;
			}) =>
				executeJson(
					"searchIssues",
					HttpClientRequest.post(`${apiBase}/search/jql`).pipe(
						HttpClientRequest.bodyUnsafeJson({
							jql: params.jql,
							maxResults: params.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
							fields: [...ISSUE_FIELDS],
						}),
					),
					JiraSearchSchema,
				).pipe(
					Effect.map((result) => result.issues),
					Effect.annotateLogs({ "jira.jql": params.jql }),
				),

			listTransitions: (key: string) =>
				executeJson(
					"listTransitions",
					HttpClientRequest.get(
						`${apiBase}/issue/${encodeIssueKey(key)}/transitions`,
					),
					JiraTransitionsSchema,
				).pipe(
					Effect.map((result) => result.transitions),
					Effect.annotateLogs({ "jira.issue.key": key }),
				),

			transitionIssue: (key: string, transitionId: string) =>
				execute(
					"transitionIssue",
					HttpClientRequest.post(
						`${apiBase}/issue/${encodeIssueKey(key)}/transitions`,
					).pipe(
						HttpClientRequest.bodyUnsafeJson({
							transition: { id: transitionId },
						}),
					),
				).pipe(
					Effect.asVoid,
					Effect.annotateLogs({
						"jira.issue.key": key,
						"jira.transition.id": transitionId,
					}),
				),

			updateLabels: (
				key: string,
				changes: {
					readonly add?: readonly string[];
					readonly remove?: readonly string[];
				},
			) => {
				const ops: Array<{ add: string } | { remove: string }> = [
					...(changes.add ?? []).map((label) => ({ add: label })),
					...(changes.remove ?? []).map((label) => ({ remove: label })),
				];
				if (ops.length === 0) return Effect.void;
				return execute(
					"updateLabels",
					HttpClientRequest.put(`${apiBase}/issue/${encodeIssueKey(key)}`).pipe(
						HttpClientRequest.bodyUnsafeJson({ update: { labels: ops } }),
					),
				).pipe(
					Effect.asVoid,
					Effect.annotateLogs({
						"jira.issue.key": key,
						"jira.labels.add": (changes.add ?? []).join(","),
						"jira.labels.remove": (changes.remove ?? []).join(","),
					}),
				);
			},

			getMyself: () =>
				executeJson(
					"getMyself",
					HttpClientRequest.get(`${apiBase}/myself`),
					JiraMyselfSchema,
				),

			assignIssue: (key: string, accountId: string) =>
				execute(
					"assignIssue",
					HttpClientRequest.put(
						`${apiBase}/issue/${encodeIssueKey(key)}/assignee`,
					).pipe(HttpClientRequest.bodyUnsafeJson({ accountId })),
				).pipe(
					Effect.asVoid,
					Effect.annotateLogs({
						"jira.issue.key": key,
						"jira.assignee.account_id": accountId,
					}),
				),
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
