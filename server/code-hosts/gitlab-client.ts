import { HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import type { HttpClientError } from "../http/errors.ts";
import {
	parseResponseBody,
	platformHttpClient,
} from "../http/platform-client.ts";
import {
	GitLabMergeRequestSchema,
	GitLabMergeRequestsSchema,
	GitLabProjectSchema,
} from "./schemas.ts";

type GitLabClientOptions = {
	readonly token: string;
	readonly baseUrl?: string;
};

export const gitlabClient = (options: GitLabClientOptions) =>
	Effect.gen(function* () {
		const baseUrl = options.baseUrl ?? "https://gitlab.com";

		const { http, instrument } = yield* platformHttpClient({
			service: "gitlab",
			baseUrl: `${baseUrl}/api/v4`,
			mapRequest: (req) =>
				req.pipe(HttpClientRequest.setHeader("PRIVATE-TOKEN", options.token)),
		});

		const getProject = (
			repo: string,
		): Effect.Effect<{ default_branch: string }, HttpClientError> =>
			http
				.execute(HttpClientRequest.get(`/projects/${encodeProjectPath(repo)}`))
				.pipe(
					parseResponseBody(GitLabProjectSchema),
					instrument("getProject", { "code_host.repo": repo }),
				);

		const listMergeRequests = (
			repo: string,
			params: {
				readonly source_branch: string;
				readonly target_branch: string;
			},
		): Effect.Effect<
			ReadonlyArray<{ iid: number; web_url: string }>,
			HttpClientError
		> => {
			const query = new URLSearchParams({
				source_branch: params.source_branch,
				target_branch: params.target_branch,
				state: "opened",
			});
			return http
				.execute(
					HttpClientRequest.get(
						`/projects/${encodeProjectPath(repo)}/merge_requests?${query}`,
					),
				)
				.pipe(
					parseResponseBody(GitLabMergeRequestsSchema),
					instrument("listMergeRequests", { "code_host.repo": repo }),
				);
		};

		const createMergeRequest = (
			repo: string,
			params: {
				readonly source_branch: string;
				readonly target_branch: string;
				readonly title: string;
				readonly description: string;
			},
		): Effect.Effect<{ iid: number; web_url: string }, HttpClientError> =>
			http
				.execute(
					HttpClientRequest.post(
						`/projects/${encodeProjectPath(repo)}/merge_requests`,
					).pipe(HttpClientRequest.bodyUnsafeJson(params)),
				)
				.pipe(
					parseResponseBody(GitLabMergeRequestSchema),
					instrument("createMergeRequest", { "code_host.repo": repo }),
				);

		return {
			baseUrl,
			getProject,
			listMergeRequests,
			createMergeRequest,
		};
	});

const encodeProjectPath = (projectPath: string): string =>
	encodeURIComponent(projectPath);
