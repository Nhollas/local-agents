import type { GitLabClient } from "../gitlab-client.ts";
import { decorateCodeHost } from "./decorator.ts";
import type { ChangeRequest, CodeHostAdapter } from "./types.ts";

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

export function gitlabCodeHostAdapter(
	client: GitLabClient,
	baseUrl = "https://gitlab.com",
): CodeHostAdapter {
	const cloneBaseUrl = trimTrailingSlash(baseUrl);

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
			return `${cloneBaseUrl}/${repo}.git`;
		},

		async createChangeRequest(
			repo,
			head,
			base,
			title,
			body,
		): Promise<ChangeRequest> {
			const [existing] = await client.listMergeRequests(repo, {
				source_branch: head,
				target_branch: base,
				state: "opened",
			});

			if (existing) {
				return { number: existing.iid, url: existing.web_url };
			}

			const mr = await client.createMergeRequest(repo, {
				source_branch: head,
				target_branch: base,
				title,
				description: body,
			});
			return { number: mr.iid, url: mr.web_url };
		},
	});
}
