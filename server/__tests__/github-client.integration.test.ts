import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../github-client.ts";
import { GITHUB_API, REPO } from "../testing/support/fixtures.ts";
import { server } from "../testing/support/msw.ts";

describe("GitHub client retry", () => {
	it("retries on 500 and succeeds on the next attempt", async () => {
		server.use(
			http.get(
				`${GITHUB_API}/user`,
				() => new HttpResponse(null, { status: 500 }),
				{ once: true },
			),
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });
		const user = await client.getAuthenticatedUser();

		expect(user).toEqual({ login: "test-user" });
	});

	it("uses exponential backoff on 429 without Retry-After header", async () => {
		server.use(
			http.get(
				`${GITHUB_API}/user`,
				() => new HttpResponse(null, { status: 429 }),
				{ once: true },
			),
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });
		const user = await client.getAuthenticatedUser();

		expect(user).toEqual({ login: "test-user" });
	});

	it("retries on 429 and respects Retry-After header", async () => {
		server.use(
			http.get(
				`${GITHUB_API}/user`,
				() =>
					new HttpResponse(null, {
						status: 429,
						headers: { "Retry-After": "0" },
					}),
				{ once: true },
			),
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });
		const user = await client.getAuthenticatedUser();

		expect(user).toEqual({ login: "test-user" });
	});

	it("throws after exhausting all retry attempts", async () => {
		server.use(
			http.get(
				`${GITHUB_API}/user`,
				() => new HttpResponse(null, { status: 500 }),
			),
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
		server.use(
			http.get(
				`${GITHUB_API}/repos/${REPO}/issues/999`,
				() => new HttpResponse("Not Found", { status: 404 }),
				{ once: true },
			),
			http.get(`${GITHUB_API}/repos/${REPO}/issues/999`, () =>
				HttpResponse.json({
					number: 999,
					title: "should not be reached",
					body: "",
					labels: [],
					html_url: "",
					created_at: "2026-01-01T00:00:00Z",
				}),
			),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });

		await expect(client.getIssue(REPO, 999)).rejects.toThrow("failed (404)");
	});

	it("retries on network errors", async () => {
		server.use(
			http.get(`${GITHUB_API}/user`, () => HttpResponse.error(), {
				once: true,
			}),
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
		);

		const client = createGitHubClient("test-token", { baseDelayMs: 1 });
		const user = await client.getAuthenticatedUser();

		expect(user).toEqual({ login: "test-user" });
	});

	it("throws after exhausting all attempts on network errors", async () => {
		server.use(http.get(`${GITHUB_API}/user`, () => HttpResponse.error()));

		const client = createGitHubClient("test-token", {
			maxAttempts: 2,
			baseDelayMs: 1,
		});

		await expect(client.getAuthenticatedUser()).rejects.toThrow(
			"GitHub API GET /user failed after 2 attempts",
		);
	});
});
