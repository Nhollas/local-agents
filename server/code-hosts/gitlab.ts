import type { HttpClient } from "@effect/platform";
import { Effect, Metric } from "effect";
import type { CodeHostError } from "./errors.ts";
import { gitlabClient } from "./gitlab-client.ts";
import { changeRequests } from "./metrics.ts";
import type { CodeHostAdapter } from "./types.ts";

export type GitLabAdapterOptions = {
	readonly token: string;
	readonly baseUrl?: string;
	readonly cloneToken?: string;
};

export const createGitLabAdapter = (
	options: GitLabAdapterOptions,
): Effect.Effect<CodeHostAdapter, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const client = yield* gitlabClient(
			options.baseUrl !== undefined
				? { token: options.token, baseUrl: options.baseUrl }
				: { token: options.token },
		);
		const cloneToken = options.cloneToken;
		const baseUrl = client.baseUrl;

		return {
			cloneUrl(repo) {
				const url = `${baseUrl}/${repo}.git`;
				if (!cloneToken) return url;
				// Embed the token as HTTP basic auth so `git clone` (and later
				// push/fetch from the same remote) authenticate to GitLab.
				return url.replace(
					/^(https?:\/\/)/,
					`$1oauth2:${encodeURIComponent(cloneToken)}@`,
				);
			},

			repoUrl(repo) {
				return `${baseUrl}/${repo}`;
			},

			defaultBranch: (repo) =>
				client.getProject(repo).pipe(Effect.map((p) => p.default_branch)),

			createChangeRequest: (
				repo,
				head,
				base,
				title,
				body,
			): Effect.Effect<{ number: number; url: string }, CodeHostError> =>
				Effect.gen(function* () {
					const existing = yield* client.listMergeRequests(repo, {
						source_branch: head,
						target_branch: base,
					});
					const [first] = existing;
					if (first) {
						yield* Metric.update(
							changeRequests.pipe(
								Metric.tagged("host", "gitlab"),
								Metric.tagged("outcome", "existing"),
							),
							1,
						);
						return { number: first.iid, url: first.web_url };
					}
					const mr = yield* client.createMergeRequest(repo, {
						source_branch: head,
						target_branch: base,
						title,
						description: body,
					});
					yield* Metric.update(
						changeRequests.pipe(
							Metric.tagged("host", "gitlab"),
							Metric.tagged("outcome", "created"),
						),
						1,
					);
					return { number: mr.iid, url: mr.web_url };
				}),
		};
	});
