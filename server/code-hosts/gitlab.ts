import type { GitLabClient } from "../gitlab-client.ts";
import type { ChangeRequest, CodeHostAdapter } from "./types.ts";

export function gitlabCodeHostAdapter(
	client: GitLabClient,
	cloneToken?: string,
): CodeHostAdapter {
	return {
		cloneUrl(repo): string {
			const url = `${client.baseUrl}/${repo}.git`;
			if (!cloneToken) return url;
			// Embed the token as HTTP basic auth so `git clone` (and later
			// push/fetch from the same remote) authenticate to GitLab.
			return url.replace(
				/^(https?:\/\/)/,
				`$1oauth2:${encodeURIComponent(cloneToken)}@`,
			);
		},

		async defaultBranch(repo) {
			const project = await client.getProject(repo);
			return project.default_branch;
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
	};
}
