import { HttpClientRequest } from "@effect/platform";
import { Effect } from "effect";
import { makeServiceHttpClient } from "../http/service-client.ts";
import type { RepoSlug } from "../types/brands.ts";
import {
	GitHubPullRequestSchema,
	GitHubPullRequestsSchema,
	GitHubRepoSchema,
} from "./schemas.ts";

type GitHubClientOptions = {
	readonly token: string;
};

export const makeGitHubClient = (options: GitHubClientOptions) =>
	Effect.gen(function* () {
		const authHeader = `Bearer ${options.token}`;
		const { executeJson } = yield* makeServiceHttpClient({
			service: "github",
			mapRequest: (req) =>
				req.pipe(
					HttpClientRequest.setHeader("Authorization", authHeader),
					HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
					HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
				),
		});

		return {
			getRepo: (repo: RepoSlug) =>
				executeJson(
					"getRepo",
					HttpClientRequest.get(`${BASE_URL}/repos/${repo}`),
					GitHubRepoSchema,
				).pipe(Effect.annotateLogs({ "code_host.repo": repo })),

			listPullRequests: (
				repo: RepoSlug,
				params: { readonly head: string; readonly base: string },
			) => {
				const query = new URLSearchParams({
					head: params.head,
					base: params.base,
					state: "open",
				});
				return executeJson(
					"listPullRequests",
					HttpClientRequest.get(`${BASE_URL}/repos/${repo}/pulls?${query}`),
					GitHubPullRequestsSchema,
				).pipe(Effect.annotateLogs({ "code_host.repo": repo }));
			},

			createPullRequest: (
				repo: RepoSlug,
				params: {
					readonly title: string;
					readonly body: string;
					readonly head: string;
					readonly base: string;
				},
			) =>
				executeJson(
					"createPullRequest",
					HttpClientRequest.post(`${BASE_URL}/repos/${repo}/pulls`).pipe(
						HttpClientRequest.bodyUnsafeJson(params),
					),
					GitHubPullRequestSchema,
				).pipe(Effect.annotateLogs({ "code_host.repo": repo })),
		};
	});

const BASE_URL = "https://api.github.com";
