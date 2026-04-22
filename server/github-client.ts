import { z } from "zod";

const BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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

type GitHubClientOptions = {
	maxAttempts?: number;
	baseDelayMs?: number;
	requestTimeoutMs?: number;
};

export function createGitHubClient(
	token: string,
	options?: GitHubClientOptions,
): GitHubClient {
	const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	function retryDelay(response: Response, attempt: number): number {
		if (response.status === 429) {
			const retryAfter = response.headers.get("Retry-After");
			if (retryAfter) return Number.parseInt(retryAfter, 10) * 1000;
		}
		return baseDelayMs * 2 ** (attempt - 1);
	}

	async function request<T extends z.ZodType>(
		path: string,
		options: { method?: string; body?: Record<string, unknown>; schema: T },
	): Promise<z.infer<T>>;
	async function request(
		path: string,
		options?: { method?: string; body?: Record<string, unknown> },
	): Promise<void>;
	async function request(
		path: string,
		options: {
			method?: string;
			body?: Record<string, unknown>;
			schema?: z.ZodType;
		} = {},
	) {
		const { method = "GET", body, schema } = options;
		const url = `${BASE_URL}${path}`;

		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};

		if (body) {
			headers["Content-Type"] = "application/json";
		}

		const init: RequestInit = { method, headers };
		if (body) {
			init.body = JSON.stringify(body);
		}

		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let response: Response;
			try {
				response = await fetch(url, {
					...init,
					signal: AbortSignal.timeout(requestTimeoutMs),
				});
			} catch (err) {
				lastError = err;
				if (attempt < maxAttempts) {
					await sleep(baseDelayMs * 2 ** (attempt - 1));
					continue;
				}
				/* v8 ignore next -- defensive: fetch always rejects with an Error */
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(
					`GitHub API ${method} ${path} failed after ${maxAttempts} attempts: ${message}`,
				);
			}

			if (response.ok) {
				if (!schema) return;
				const text = await response.text();
				return schema.parse(JSON.parse(text));
			}

			if (isRetryableStatus(response.status) && attempt < maxAttempts) {
				await sleep(retryDelay(response, attempt));
				continue;
			}

			const text = await response.text();
			throw new Error(
				`GitHub API ${method} ${path} failed (${response.status}): ${text}`,
			);
		}

		/* v8 ignore next -- defensive: loop always returns or throws */
		throw lastError;
	}

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
