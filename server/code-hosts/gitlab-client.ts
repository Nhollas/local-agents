import type { HttpClient } from "@effect/platform";
import { HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import type { HttpClientError } from "../http/errors.ts";
import { makeServiceHttpClient } from "../http/service-client.ts";
import type { RepoSlug } from "../types/brands.ts";
import {
	GitLabMergeRequestSchema,
	GitLabMergeRequestsSchema,
	GitLabProjectSchema,
} from "./schemas.ts";

type GitLabClientOptions = {
	readonly token: string;
	readonly baseUrl?: string;
};

type GitLabClient = {
	readonly baseUrl: string;
	getProject(
		repo: RepoSlug,
	): Effect.Effect<{ default_branch: string }, HttpClientError>;
	listMergeRequests(
		repo: RepoSlug,
		params: { readonly source_branch: string; readonly target_branch: string },
	): Effect.Effect<
		ReadonlyArray<{ iid: number; web_url: string }>,
		HttpClientError
	>;
	createMergeRequest(
		repo: RepoSlug,
		params: {
			readonly source_branch: string;
			readonly target_branch: string;
			readonly title: string;
			readonly description: string;
		},
	): Effect.Effect<{ iid: number; web_url: string }, HttpClientError>;
};

export const makeGitLabClient = (
	options: GitLabClientOptions,
): Effect.Effect<GitLabClient, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		const apiBase = `${baseUrl}/api/v4`;

		const { executeJson } = yield* makeServiceHttpClient({
			service: "gitlab",
			mapRequest: (req) =>
				req.pipe(HttpClientRequest.setHeader("PRIVATE-TOKEN", options.token)),
		});

		return {
			baseUrl,

			getProject: (repo) =>
				executeJson(
					"getProject",
					HttpClientRequest.get(
						`${apiBase}/projects/${encodeProjectPath(repo)}`,
					),
					GitLabProjectSchema,
				).pipe(Effect.annotateLogs({ "code_host.repo": repo })),

			listMergeRequests: (repo, params) => {
				const query = new URLSearchParams({
					source_branch: params.source_branch,
					target_branch: params.target_branch,
					state: "opened",
				});
				return executeJson(
					"listMergeRequests",
					HttpClientRequest.get(
						`${apiBase}/projects/${encodeProjectPath(repo)}/merge_requests?${query}`,
					),
					GitLabMergeRequestsSchema,
				).pipe(Effect.annotateLogs({ "code_host.repo": repo }));
			},

			createMergeRequest: (repo, params) =>
				executeJson(
					"createMergeRequest",
					HttpClientRequest.post(
						`${apiBase}/projects/${encodeProjectPath(repo)}/merge_requests`,
					).pipe(HttpClientRequest.bodyUnsafeJson(params)),
					GitLabMergeRequestSchema,
				).pipe(Effect.annotateLogs({ "code_host.repo": repo })),
		};
	});

const DEFAULT_BASE_URL = "https://gitlab.com";

function encodeProjectPath(projectPath: RepoSlug): string {
	return encodeURIComponent(projectPath);
}
