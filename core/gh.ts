const BASE_URL = "https://api.github.com";

type RequestOptions = {
	method?: string;
	body?: Record<string, unknown>;
};

export type GitHubClient = {
	get: <T>(path: string) => Promise<T>;
	post: <T>(path: string, body: Record<string, unknown>) => Promise<T>;
	delete: (path: string) => Promise<void>;
};

export function createGitHubClient(token: string): GitHubClient {
	async function request<T>(
		path: string,
		options: RequestOptions = {},
	): Promise<T> {
		const { method = "GET", body } = options;

		const headers: Record<string, string> = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};

		if (body) {
			headers["Content-Type"] = "application/json";
		}

		const response = await fetch(`${BASE_URL}${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`GitHub API ${method} ${path} failed (${response.status}): ${text}`,
			);
		}

		const text = await response.text();
		return text ? JSON.parse(text) : (undefined as T);
	}

	return {
		get: <T>(path: string) => request<T>(path),
		post: <T>(path: string, body: Record<string, unknown>) =>
			request<T>(path, { method: "POST", body }),
		delete: (path: string) => request(path, { method: "DELETE" }),
	};
}
