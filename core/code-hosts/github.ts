import type { GitHubClient } from "../gh.ts";
import type { CodeHostAdapter, PullRequest } from "../types.ts";

type GitHubContent = {
	content: string;
};

type GitHubPullRequest = {
	number: number;
	html_url: string;
};

export function createGitHubCodeHost(client: GitHubClient): CodeHostAdapter {
	return {
		async fetchFile(
			repo: string,
			path: string,
			ref?: string,
		): Promise<string | null> {
			try {
				const encodedPath = path.split("/").map(encodeURIComponent).join("/");
				const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
				const content = await client.get<GitHubContent>(
					`/repos/${repo}/contents/${encodedPath}${query}`,
				);
				return Buffer.from(content.content, "base64").toString("utf-8");
			} catch {
				return null;
			}
		},

		cloneUrl(repo: string): string {
			return `https://github.com/${repo}.git`;
		},

		async createPullRequest(
			repo: string,
			head: string,
			base: string,
			title: string,
			body: string,
		): Promise<PullRequest> {
			const pr = await client.post<GitHubPullRequest>(
				`/repos/${repo}/pulls`,
				{ title, body, head, base },
			);
			return { number: pr.number, url: pr.html_url };
		},
	};
}
