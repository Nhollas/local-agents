import type { z } from "zod";

export type HttpClientOptions = {
	maxAttempts?: number;
	baseDelayMs?: number;
	requestTimeoutMs?: number;
};

type JsonRequesterOptions = HttpClientOptions & {
	baseUrl: string;
	serviceName: string;
	headers: Record<string, string>;
};

type RequestOptions<T extends z.ZodType> = {
	method?: string;
	body?: Record<string, unknown>;
	schema: T;
};

type VoidRequestOptions = {
	method?: string;
	body?: Record<string, unknown>;
};

export function createJsonRequester(options: JsonRequesterOptions) {
	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

	async function request<T extends z.ZodType>(
		path: string,
		requestOptions: RequestOptions<T>,
	): Promise<z.infer<T>>;
	async function request(
		path: string,
		requestOptions?: VoidRequestOptions,
	): Promise<void>;
	async function request(
		path: string,
		requestOptions: VoidRequestOptions & { schema?: z.ZodType } = {},
	) {
		const { method = "GET", body, schema } = requestOptions;
		const url = `${options.baseUrl}${path}`;
		const headers: Record<string, string> = { ...options.headers };

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
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(
					`${options.serviceName} API ${method} ${path} failed after ${maxAttempts} attempts: ${message}`,
				);
			}

			if (response.ok) {
				if (!schema) return;
				const text = await response.text();
				return schema.parse(JSON.parse(text));
			}

			if (isRetryableStatus(response.status) && attempt < maxAttempts) {
				await sleep(retryDelay(response, attempt, baseDelayMs));
				continue;
			}

			const text = await response.text();
			throw new Error(
				`${options.serviceName} API ${method} ${path} failed (${response.status}): ${text}`,
			);
		}

		throw lastError;
	}

	return request;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(
	response: Response,
	attempt: number,
	baseDelayMs: number,
): number {
	if (response.status === 429) {
		const retryAfter = response.headers.get("Retry-After");
		if (retryAfter) return Number.parseInt(retryAfter, 10) * 1000;
	}
	return baseDelayMs * 2 ** (attempt - 1);
}
