import type { HttpClient } from "@effect/platform";
import { Effect } from "effect";
import type { CodeHostError } from "./errors.ts";
import { githubClient } from "./github-client.ts";
import type { CodeHostAdapter } from "./types.ts";

type GitHubAdapterOptions = {
	readonly token: string;
	readonly cloneToken?: string;
};

export const createGitHubAdapter = (
	options: GitHubAdapterOptions,
): Effect.Effect<CodeHostAdapter, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const client = yield* githubClient({ token: options.token });
		const cloneToken = options.cloneToken;

		return {
			cloneUrl(repo) {
				if (!cloneToken) return `https://github.com/${repo}.git`;
				// GitHub's documented PAT-over-HTTPS form: the literal username
				// `x-access-token`, with the token in the password slot.
				return `https://x-access-token:${encodeURIComponent(cloneToken)}@github.com/${repo}.git`;
			},

			repoUrl(repo) {
				return `https://github.com/${repo}`;
			},

			defaultBranch: (repo) =>
				client.getRepo(repo).pipe(Effect.map((r) => r.default_branch)),

			createChangeRequest: (
				repo,
				head,
				base,
				title,
				body,
			): Effect.Effect<{ number: number; url: string }, CodeHostError> =>
				Effect.gen(function* () {
					const owner = repo.split("/")[0];
					const existing = yield* client.listPullRequests(repo, {
						head: `${owner}:${head}`,
						base,
					});
					const [first] = existing;
					if (first) {
						return { number: first.number, url: first.html_url };
					}
					const pr = yield* client.createPullRequest(repo, {
						title,
						body,
						head,
						base,
					});
					return { number: pr.number, url: pr.html_url };
				}),
		};
	});
