import type { GitHubClient } from "../github-client.ts";
import { branchName } from "../types/brands.ts";
import { decorateCodeHost } from "./decorator.ts";
import type { ChangeRequest, CodeHostAdapter } from "./types.ts";

export function githubCodeHostAdapter(client: GitHubClient): CodeHostAdapter {
	return decorateCodeHost({
		async fetchFile(repo, path, ref): Promise<string | null> {
			try {
				const content = await client.getFileContent(repo, path, ref);
				return Buffer.from(content.content, "base64").toString("utf-8");
			} catch {
				return null;
			}
		},

		cloneUrl(repo): string {
			return `https://github.com/${repo}.git`;
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
				head: branchName(`${owner}:${head}`),
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
	});
}
