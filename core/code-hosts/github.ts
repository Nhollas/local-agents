import { gh } from "../gh.ts";
import type { CodeHostAdapter, PullRequest } from "../types.ts";

export function createGitHubCodeHost(): CodeHostAdapter {
	return {
		async fetchFile(
			repo: string,
			path: string,
			ref?: string,
		): Promise<string | null> {
			try {
				const encodedPath = path.split("/").map(encodeURIComponent).join("/");
				const endpoint = ref
					? `repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
					: `repos/${repo}/contents/${encodedPath}`;
				const stdout = await gh("api", endpoint, "--jq", ".content");
				return Buffer.from(stdout, "base64").toString("utf-8");
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
			const stdout = await gh(
				"api",
				`repos/${repo}/pulls`,
				"--method",
				"POST",
				"-f",
				`title=${title}`,
				"-f",
				`body=${body}`,
				"-f",
				`head=${head}`,
				"-f",
				`base=${base}`,
			);
			const pr = JSON.parse(stdout);
			return { number: pr.number, url: pr.html_url };
		},
	};
}
