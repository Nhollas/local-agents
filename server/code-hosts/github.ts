import { z } from "zod";
import type { GitHubClient } from "../github-client.ts";
import { decorateCodeHost } from "./decorator.ts";
import type { ChangeRequest, CodeHostAdapter } from "./types.ts";

const githubContentSchema = z.object({
	content: z.string(),
});

const githubPullRequestSchema = z.object({
	number: z.number(),
	html_url: z.string(),
});
const githubPullRequestsSchema = z.array(githubPullRequestSchema);

export function githubCodeHostAdapter(client: GitHubClient): CodeHostAdapter {
	return decorateCodeHost({
		async fetchFile(
			repo: string,
			path: string,
			ref?: string,
		): Promise<string | null> {
			try {
				const encodedPath = path.split("/").map(encodeURIComponent).join("/");
				const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
				const content = await client.get(
					`/repos/${repo}/contents/${encodedPath}${query}`,
					githubContentSchema,
				);
				return Buffer.from(content.content, "base64").toString("utf-8");
			} catch {
				return null;
			}
		},

		cloneUrl(repo: string): string {
			return `https://github.com/${repo}.git`;
		},

		async createChangeRequest(
			repo: string,
			head: string,
			base: string,
			title: string,
			body: string,
		): Promise<ChangeRequest> {
			const owner = repo.split("/")[0];
			const [existing] = await client.get(
				`/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
				githubPullRequestsSchema,
			);

			if (existing) {
				return { number: existing.number, url: existing.html_url };
			}

			const pr = await client.post(
				`/repos/${repo}/pulls`,
				{ title, body, head, base },
				githubPullRequestSchema,
			);
			return { number: pr.number, url: pr.html_url };
		},
	});
}
