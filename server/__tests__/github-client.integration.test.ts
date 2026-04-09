import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../github-client.ts";
import { GITHUB_API, REPO } from "../testing/support/fixtures.ts";
import { server } from "../testing/support/msw.ts";

describe("GitHub client retry", () => {
	it("retries on 500 and succeeds on the next attempt", async () => {
		let attempts = 0;
		server.use(
			http.get(`${GITHUB_API}/user`, () => {
				attempts++;
				if (attempts === 1) {
					return new HttpResponse(null, { status: 500 });
				}
				return HttpResponse.json({ login: "test-user" });
			}),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });
		const user = await client.getAuthenticatedUser();

		expect(user).toEqual({ login: "test-user" });
		expect(attempts).toBe(2);
	});

	it("uses exponential backoff on 429 without Retry-After header", async () => {
		let attempts = 0;
		server.use(
			http.get(`${GITHUB_API}/user`, () => {
				attempts++;
				if (attempts === 1) {
					return new HttpResponse(null, { status: 429 });
				}
				return HttpResponse.json({ login: "test-user" });
			}),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });
		const user = await client.getAuthenticatedUser();

		expect(user).toEqual({ login: "test-user" });
		expect(attempts).toBe(2);
	});

	it("retries on 429 and respects Retry-After header", async () => {
		let attempts = 0;
		server.use(
			http.get(`${GITHUB_API}/user`, () => {
				attempts++;
				if (attempts === 1) {
					return new HttpResponse(null, {
						status: 429,
						headers: { "Retry-After": "0" },
					});
				}
				return HttpResponse.json({ login: "test-user" });
			}),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });
		const user = await client.getAuthenticatedUser();

		expect(user).toEqual({ login: "test-user" });
		expect(attempts).toBe(2);
	});

	it("throws after exhausting all retry attempts", async () => {
		server.use(
			http.get(`${GITHUB_API}/user`, () => {
				return new HttpResponse(null, { status: 500 });
			}),
		);

		const client = createGitHubClient("test-token", {
			maxAttempts: 2,
			baseDelayMs: 1,
		});

		await expect(client.getAuthenticatedUser()).rejects.toThrow(
			"GitHub API GET /user failed (500)",
		);
	});

	it("does not retry on 4xx errors", async () => {
		let attempts = 0;
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/issues/999`, () => {
				attempts++;
				return new HttpResponse("Not Found", { status: 404 });
			}),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });

		await expect(client.getIssue(REPO, 999)).rejects.toThrow("failed (404)");
		expect(attempts).toBe(1);
	});

	it("retries on network errors", async () => {
		let attempts = 0;
		server.use(
			http.get(`${GITHUB_API}/user`, () => {
				attempts++;
				if (attempts === 1) {
					return HttpResponse.error();
				}
				return HttpResponse.json({ login: "test-user" });
			}),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });
		const user = await client.getAuthenticatedUser();

		expect(user).toEqual({ login: "test-user" });
		expect(attempts).toBe(2);
	});

	it("throws after exhausting all attempts on network errors", async () => {
		server.use(
			http.get(`${GITHUB_API}/user`, () => {
				return HttpResponse.error();
			}),
		);

		const client = createGitHubClient("test-token", {
			maxAttempts: 2,
			baseDelayMs: 1,
		});

		await expect(client.getAuthenticatedUser()).rejects.toThrow(
			"GitHub API GET /user failed after 2 attempts",
		);
	});
});
