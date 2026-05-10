import type { GitHubClient } from "./github-client.ts";
import type { ChangeRequest, CodeHostAdapter } from "./types.ts";

export function githubCodeHostAdapter(
	client: GitHubClient,
	cloneToken?: string,
): CodeHostAdapter {
	return {
		cloneUrl(repo): string {
			if (!cloneToken) return `https://github.com/${repo}.git`;
			// GitHub's documented PAT-over-HTTPS form: the literal username
			// `x-access-token`, with the token in the password slot.
			return `https://x-access-token:${encodeURIComponent(cloneToken)}@github.com/${repo}.git`;
		},

		repoUrl(repo): string {
			return `https://github.com/${repo}`;
		},

		async defaultBranch(repo) {
			const project = await client.getRepo(repo);
			return project.default_branch;
		},

		async createChangeRequest(
			repo,
			head,
			base,
			title,
			body,
		): Promise<ChangeRequest> {
			const owner = repo.split("/")[0];
			const [existing] = await client.listPullRequests(repo, {
				head: `${owner}:${head}`,
				base,
				state: "open",
			});

			if (existing) {
				return { number: existing.number, url: existing.html_url };
			}

			const pr = await client.createPullRequest(repo, {
				title,
				body,
				head,
				base,
			});
			return { number: pr.number, url: pr.html_url };
		},
	};
}
