import { z } from "zod";
import { createJsonRequester, type HttpClientOptions } from "../http-client.ts";
import type { RepoSlug } from "../types/brands.ts";

const githubRepoSchema = z.object({
	default_branch: z.string().min(1),
});

const githubContentSchema = z.object({
	content: z.string(),
});

const githubPullRequestSchema = z.object({
	number: z.number(),
	html_url: z.string(),
});

type GitHubRepo = z.infer<typeof githubRepoSchema>;
type GitHubContent = z.infer<typeof githubContentSchema>;
type GitHubPullRequest = z.infer<typeof githubPullRequestSchema>;

export type GitHubClient = {
	getRepo(repo: RepoSlug): Promise<GitHubRepo>;
	getFileContent(
		repo: RepoSlug,
		path: string,
		ref?: string,
	): Promise<GitHubContent>;
	listPullRequests(
		repo: RepoSlug,
		params: { head: string; base: string; state: string },
	): Promise<GitHubPullRequest[]>;
	createPullRequest(
		repo: RepoSlug,
		params: {
			title: string;
			body: string;
			head: string;
			base: string;
		},
	): Promise<GitHubPullRequest>;
};

export function createGitHubClient(
	token: string,
	options: HttpClientOptions = {},
): GitHubClient {
	const request = createJsonRequester({
		...options,
		baseUrl: BASE_URL,
		serviceName: "GitHub",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});

	return {
		getRepo(repo) {
			return request(`/repos/${repo}`, { schema: githubRepoSchema });
		},

		getFileContent(repo, path, ref) {
			const encodedPath = path.split("/").map(encodeURIComponent).join("/");
			const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
			return request(`/repos/${repo}/contents/${encodedPath}${query}`, {
				schema: githubContentSchema,
			});
		},

		listPullRequests(repo, params) {
			const query = new URLSearchParams(params);
			return request(`/repos/${repo}/pulls?${query}`, {
				schema: z.array(githubPullRequestSchema),
			});
		},

		createPullRequest(repo, params) {
			return request(`/repos/${repo}/pulls`, {
				method: "POST",
				body: params,
				schema: githubPullRequestSchema,
			});
		},
	};
}

const BASE_URL = "https://api.github.com";
