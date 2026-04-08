import type { z } from "zod";

const BASE_URL = "https://api.github.com";

type RequestOptions = {
	method?: string;
	body?: Record<string, unknown>;
	schema?: z.ZodType | undefined;
};

export type GitHubClient = {
	get: <T extends z.ZodType>(path: string, schema: T) => Promise<z.infer<T>>;
	post: {
		<T extends z.ZodType>(
			path: string,
			body: Record<string, unknown>,
			schema: T,
		): Promise<z.infer<T>>;
		(path: string, body: Record<string, unknown>): Promise<void>;
	};
	delete: (path: string) => Promise<void>;
};

export function createGitHubClient(token: string): GitHubClient {
	async function request(
		path: string,
		options: RequestOptions = {},
	): Promise<unknown> {
		const { method = "GET", body, schema } = options;

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

		const response = await fetch(`${BASE_URL}${path}`, init);

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`GitHub API ${method} ${path} failed (${response.status}): ${text}`,
			);
		}

		if (!schema) {
			return;
		}

		const text = await response.text();
		return schema.parse(JSON.parse(text));
	}

	function get<T extends z.ZodType>(
		path: string,
		schema: T,
	): Promise<z.infer<T>> {
		return request(path, { schema }) as Promise<z.infer<T>>;
	}

	function post<T extends z.ZodType>(
		path: string,
		body: Record<string, unknown>,
		schema: T,
	): Promise<z.infer<T>>;
	function post(path: string, body: Record<string, unknown>): Promise<void>;
	function post(
		path: string,
		body: Record<string, unknown>,
		schema?: z.ZodType,
	) {
		return request(path, { method: "POST", body, schema });
	}

	return {
		get,
		post,
		delete: (path: string) =>
			request(path, { method: "DELETE" }) as Promise<void>,
	};
}
