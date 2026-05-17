import { HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import type { HttpClientError } from "../http/errors.ts";
import {
	parseResponseBody,
	platformHttpClient,
} from "../http/platform-client.ts";
import type { RepoSlug } from "../types/brands.ts";
import {
	GitHubPullRequestSchema,
	GitHubPullRequestsSchema,
	GitHubRepoSchema,
} from "./schemas.ts";

type GitHubClientOptions = {
	readonly token: string;
};

export const githubClient = (options: GitHubClientOptions) =>
	Effect.gen(function* () {
		const authHeader = `Bearer ${options.token}`;

		const { http, instrument } = yield* platformHttpClient({
			service: "github",
			baseUrl: "https://api.github.com",
			mapRequest: (req) =>
				req.pipe(
					HttpClientRequest.setHeader("Authorization", authHeader),
					HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
					HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
				),
		});

		const getRepo = (
			repo: RepoSlug,
		): Effect.Effect<{ default_branch: string }, HttpClientError> =>
			http
				.execute(HttpClientRequest.get(`/repos/${repo}`))
				.pipe(
					parseResponseBody(GitHubRepoSchema),
					instrument("getRepo", { "code_host.repo": repo }),
				);

		const listPullRequests = (
			repo: RepoSlug,
			params: { readonly head: string; readonly base: string },
		): Effect.Effect<
			ReadonlyArray<{ number: number; html_url: string }>,
			HttpClientError
		> => {
			const query = new URLSearchParams({
				head: params.head,
				base: params.base,
				state: "open",
			});
			return http
				.execute(HttpClientRequest.get(`/repos/${repo}/pulls?${query}`))
				.pipe(
					parseResponseBody(GitHubPullRequestsSchema),
					instrument("listPullRequests", { "code_host.repo": repo }),
				);
		};

		const createPullRequest = (
			repo: RepoSlug,
			params: {
				readonly title: string;
				readonly body: string;
				readonly head: string;
				readonly base: string;
			},
		): Effect.Effect<{ number: number; html_url: string }, HttpClientError> =>
			http
				.execute(
					HttpClientRequest.post(`/repos/${repo}/pulls`).pipe(
						HttpClientRequest.bodyUnsafeJson(params),
					),
				)
				.pipe(
					parseResponseBody(GitHubPullRequestSchema),
					instrument("createPullRequest", { "code_host.repo": repo }),
				);

		return {
			getRepo,
			listPullRequests,
			createPullRequest,
		};
	});
