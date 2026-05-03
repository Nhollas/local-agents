import { z } from "zod";
import { createJsonRequester, type HttpClientOptions } from "./http-client.ts";
import type {
	BranchName,
	GitHubToken,
	IssueNumber,
	RepoSlug,
} from "./types/brands.ts";

const BASE_URL = "https://api.github.com";

const githubUserSchema = z.object({ login: z.string() });

const githubContentSchema = z.object({ content: z.string() });

const githubPullRequestSchema = z.object({
	number: z.number(),
	html_url: z.string(),
});

const githubIssueSchema = z.object({
	number: z.number(),
	title: z.string(),
	body: z.string().nullable(),
	labels: z.array(z.object({ name: z.string() })),
	html_url: z.string(),
	created_at: z.string(),
	repository_url: z.string().optional(),
});

export type GitHubIssue = z.infer<typeof githubIssueSchema>;

export type GitHubClient = {
	getAuthenticatedUser(): Promise<{ login: string }>;
	getFileContent(
		repo: RepoSlug,
		path: string,
		ref?: string,
	): Promise<{ content: string }>;
	listPullRequests(
		repo: RepoSlug,
		params: { head: BranchName; base: BranchName; state: string },
	): Promise<{ number: number; html_url: string }[]>;
	createPullRequest(
		repo: RepoSlug,
		params: {
			title: string;
			body: string;
			head: BranchName;
			base: BranchName;
		},
	): Promise<{ number: number; html_url: string }>;
	getIssue(repo: RepoSlug, issueNumber: IssueNumber): Promise<GitHubIssue>;
	searchIssues(query: string): Promise<GitHubIssue[]>;
	removeIssueLabel(
		repo: RepoSlug,
		issueNumber: IssueNumber,
		label: string,
	): Promise<void>;
	addIssueLabels(
		repo: RepoSlug,
		issueNumber: IssueNumber,
		labels: string[],
	): Promise<void>;
};

export function createGitHubClient(
	token: GitHubToken,
	options?: HttpClientOptions,
): GitHubClient {
	const request = createJsonRequester({
		baseUrl: BASE_URL,
		serviceName: "GitHub",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		...options,
	});

	return {
		getAuthenticatedUser() {
			return request("/user", { schema: githubUserSchema });
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

		getIssue(repo, issueNumber) {
			return request(`/repos/${repo}/issues/${issueNumber}`, {
				schema: githubIssueSchema,
			});
		},

		async searchIssues(query) {
			const perPage = 100;
			const params = new URLSearchParams({
				q: query,
				per_page: String(perPage),
			});
			const result = await request(`/search/issues?${params}`, {
				schema: z.object({
					total_count: z.number(),
					items: z.array(githubIssueSchema),
				}),
			});
			if (result.total_count > perPage) {
				throw new Error(
					`GitHub search returned ${result.total_count} results; per-page cap is ${perPage}. Query: ${query}`,
				);
			}
			return result.items;
		},

		removeIssueLabel(repo, issueNumber, label) {
			return request(
				`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
				{ method: "DELETE" },
			);
		},

		addIssueLabels(repo, issueNumber, labels) {
			return request(`/repos/${repo}/issues/${issueNumber}/labels`, {
				method: "POST",
				body: { labels },
			});
		},
	};
}
