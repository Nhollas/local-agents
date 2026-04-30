import { z } from "zod";
import { createJsonRequester, type HttpClientOptions } from "./http-client.ts";

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
});

export type GitHubIssue = z.infer<typeof githubIssueSchema>;

export type GitHubClient = {
	getAuthenticatedUser(): Promise<{ login: string }>;
	getFileContent(
		repo: string,
		path: string,
		ref?: string,
	): Promise<{ content: string }>;
	listPullRequests(
		repo: string,
		params: { head: string; base: string; state: string },
	): Promise<{ number: number; html_url: string }[]>;
	createPullRequest(
		repo: string,
		params: { title: string; body: string; head: string; base: string },
	): Promise<{ number: number; html_url: string }>;
	getIssue(repo: string, issueNumber: number): Promise<GitHubIssue>;
	listIssues(
		repo: string,
		params: {
			labels: string;
			state: string;
			creator: string;
			per_page: string;
		},
	): Promise<GitHubIssue[]>;
	removeIssueLabel(
		repo: string,
		issueNumber: number,
		label: string,
	): Promise<void>;
	addIssueLabels(
		repo: string,
		issueNumber: number,
		labels: string[],
	): Promise<void>;
};

export function createGitHubClient(
	token: string,
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

		getFileContent(repo: string, path: string, ref?: string) {
			const encodedPath = path.split("/").map(encodeURIComponent).join("/");
			const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
			return request(`/repos/${repo}/contents/${encodedPath}${query}`, {
				schema: githubContentSchema,
			});
		},

		listPullRequests(
			repo: string,
			params: { head: string; base: string; state: string },
		) {
			const query = new URLSearchParams(params);
			return request(`/repos/${repo}/pulls?${query}`, {
				schema: z.array(githubPullRequestSchema),
			});
		},

		createPullRequest(
			repo: string,
			params: { title: string; body: string; head: string; base: string },
		) {
			return request(`/repos/${repo}/pulls`, {
				method: "POST",
				body: params,
				schema: githubPullRequestSchema,
			});
		},

		getIssue(repo: string, issueNumber: number) {
			return request(`/repos/${repo}/issues/${issueNumber}`, {
				schema: githubIssueSchema,
			});
		},

		listIssues(
			repo: string,
			params: {
				labels: string;
				state: string;
				creator: string;
				per_page: string;
			},
		) {
			const query = new URLSearchParams(params);
			return request(`/repos/${repo}/issues?${query}`, {
				schema: z.array(githubIssueSchema),
			});
		},

		removeIssueLabel(repo: string, issueNumber: number, label: string) {
			return request(
				`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
				{ method: "DELETE" },
			);
		},

		addIssueLabels(repo: string, issueNumber: number, labels: string[]) {
			return request(`/repos/${repo}/issues/${issueNumber}/labels`, {
				method: "POST",
				body: { labels },
			});
		},
	};
}
