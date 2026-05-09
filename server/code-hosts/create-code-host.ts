import type { Config } from "../config.ts";
import { githubCodeHostAdapter } from "./github.ts";
import { createGitHubClient } from "./github-client.ts";
import { gitlabCodeHostAdapter } from "./gitlab.ts";
import { createGitLabClient } from "./gitlab-client.ts";
import type { CodeHostAdapter } from "./types.ts";

export function createCodeHost(
	codeHost: Config["code_host"],
	tokens: { gitlab: string | undefined; github: string | undefined },
): CodeHostAdapter {
	switch (codeHost.kind) {
		case "gitlab": {
			if (!tokens.gitlab) {
				throw new Error("GITLAB_TOKEN is required for GitLab code host");
			}
			const gitlab = createGitLabClient(tokens.gitlab, {
				baseUrl: codeHost.base_url,
			});
			return gitlabCodeHostAdapter(gitlab, tokens.gitlab);
		}
		case "github": {
			if (!tokens.github) {
				throw new Error("GITHUB_TOKEN is required for GitHub code host");
			}
			const github = createGitHubClient(tokens.github);
			return githubCodeHostAdapter(github, tokens.github);
		}
	}
}
