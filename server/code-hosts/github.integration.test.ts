import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { GITHUB_API, REPO } from "../test-support/fixtures.ts";
import { server } from "../test-support/msw.ts";
import { githubCodeHostAdapter } from "./github.ts";
import { createGitHubClient } from "./github-client.ts";

const adapter = githubCodeHostAdapter(createGitHubClient("test-token"));

describe("cloneUrl", () => {
	it("targets github.com", () => {
		expect(adapter.cloneUrl(REPO)).toBe(
			"https://github.com/test-owner/test-repo.git",
		);
	});

	it("embeds the configured token as x-access-token basic auth when provided", () => {
		const tokenAdapter = githubCodeHostAdapter(
			createGitHubClient("test-token"),
			"token-with/special:chars",
		);

		expect(tokenAdapter.cloneUrl(REPO)).toBe(
			"https://x-access-token:token-with%2Fspecial%3Achars@github.com/test-owner/test-repo.git",
		);
	});
});

describe("defaultBranch", () => {
	it("returns the repo's default_branch from the GitHub repo endpoint", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}`, () =>
				HttpResponse.json({ default_branch: "develop" }),
			),
		);

		await expect(adapter.defaultBranch(REPO)).resolves.toBe("develop");
	});
});

describe("createChangeRequest", () => {
	it("creates a new PR when none exists", async () => {
		const expectedBody = {
			title: "Fix issue 1",
			body: "Closes TEST-1",
			head: "agent/issue-1",
			base: "main",
		};

		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/pulls`, ({ request }) => {
				const params = new URL(request.url).searchParams;
				if (
					params.get("head") !== "test-owner:agent/issue-1" ||
					params.get("base") !== "main" ||
					params.get("state") !== "open"
				) {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json([]);
			}),
			http.post(`${GITHUB_API}/repos/${REPO}/pulls`, async ({ request }) => {
				const body = await request.json();
				if (JSON.stringify(body) !== JSON.stringify(expectedBody)) {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json({
					number: 5,
					html_url: `https://github.com/${REPO}/pull/5`,
				});
			}),
		);

		const result = await adapter.createChangeRequest(
			REPO,
			"agent/issue-1",
			"main",
			"Fix issue 1",
			"Closes TEST-1",
		);

		expect(result).toEqual({
			number: 5,
			url: `https://github.com/${REPO}/pull/5`,
		});
	});

	it("returns an existing PR for the source branch", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/pulls`, () =>
				HttpResponse.json([
					{
						number: 3,
						html_url: `https://github.com/${REPO}/pull/3`,
					},
				]),
			),
			http.post(`${GITHUB_API}/repos/${REPO}/pulls`, () =>
				HttpResponse.json(null, { status: 400 }),
			),
		);

		const result = await adapter.createChangeRequest(
			REPO,
			"agent/issue-1",
			"main",
			"Fix issue 1",
			"Closes TEST-1",
		);

		expect(result).toEqual({
			number: 3,
			url: `https://github.com/${REPO}/pull/3`,
		});
	});
});
