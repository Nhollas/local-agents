import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "@effect/platform";
import { Duration, Effect, Schedule, type Schema } from "effect";
import { makeHttpInstrument } from "../http/instrument.ts";
import { JiraHttpError, JiraParseError } from "./errors.ts";
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
		const requestTimeout = Duration.millis(DEFAULT_TIMEOUT_MS);
		const instrument = makeHttpInstrument({ service: "jira" });

		const defaultClient = yield* HttpClient.HttpClient;
		const client = defaultClient.pipe(
			HttpClient.mapRequest((req) =>
				req.pipe(
					HttpClientRequest.setHeader("Authorization", authHeader),
					HttpClientRequest.acceptJson,
				),
			),
			HttpClient.filterStatusOk,
			HttpClient.retryTransient({
				times: DEFAULT_MAX_ATTEMPTS - 1,
				schedule: Schedule.exponential(Duration.millis(DEFAULT_BASE_DELAY_MS)),
			}),
		);

		const httpErrorTags = () => ({
			ResponseError: (e: {
				request: { method: string; url: string };
				response: { status: number };
				message: string;
			}) =>
				Effect.fail(
					new JiraHttpError({
						message: e.message,
						method: e.request.method,
						url: e.request.url,
						status: e.response.status,
						cause: e,
					}),
				),
			RequestError: (e: {
				request: { method: string; url: string };
				message: string;
			}) =>
				Effect.fail(
					new JiraHttpError({
						message: e.message,
						method: e.request.method,
						url: e.request.url,
						cause: e,
					}),
				),
		});

		const timeoutFail = (request: HttpClientRequest.HttpClientRequest) =>
			Effect.timeoutFail({
				duration: requestTimeout,
				onTimeout: () =>
					new JiraHttpError({
						message: "request timed out",
						method: request.method,
						url: request.url,
					}),
			});

		const execute = (
			endpoint: string,
			request: HttpClientRequest.HttpClientRequest,
		): Effect.Effect<HttpClientResponse.HttpClientResponse, JiraHttpError> =>
			instrument(
				endpoint,
				request,
				client
					.execute(request)
					.pipe(timeoutFail(request), Effect.catchTags(httpErrorTags())),
			);

		const executeJson = <A, I>(
			endpoint: string,
			request: HttpClientRequest.HttpClientRequest,
			schema: Schema.Schema<A, I>,
		): Effect.Effect<A, JiraHttpError | JiraParseError> =>
			instrument(
				endpoint,
				request,
				client.execute(request).pipe(
					timeoutFail(request),
					Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
					Effect.catchTags({
						...httpErrorTags(),
						ParseError: (e) =>
							Effect.fail(
								new JiraParseError({
									message: e.message,
									method: request.method,
									url: request.url,
									cause: e,
								}),
							),
					}),
				),
			);

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
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;

function encodeIssueKey(key: string): string {
	return encodeURIComponent(key);
}

function basicAuth(email: string, apiToken: string): string {
	return Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
}
