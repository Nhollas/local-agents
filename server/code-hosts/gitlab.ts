import type { GitLabClient } from "../gitlab-client.ts";
import type { GitLabToken } from "../types/brands.ts";
import { decorateCodeHost } from "./decorator.ts";
import type { ChangeRequest, CodeHostAdapter } from "./types.ts";

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

export function gitlabCodeHostAdapter(
	client: GitLabClient,
	baseUrl = "https://gitlab.com",
	cloneToken?: GitLabToken,
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
			const url = `${cloneBaseUrl}/${repo}.git`;
			if (!cloneToken) return url;
			// Embed the token as HTTP basic auth so `git clone` (and later
			// push/fetch from the same remote) authenticate to GitLab.
			return url.replace(
				/^(https?:\/\/)/,
				`$1oauth2:${encodeURIComponent(cloneToken)}@`,
			);
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
