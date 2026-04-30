import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../../github-client.ts";
import { GITHUB_API, REPO } from "../../testing/support/fixtures.ts";
import { server } from "../../testing/support/msw.ts";
import { githubCodeHostAdapter } from "../github.ts";

const adapter = githubCodeHostAdapter(createGitHubClient("test-token"));

describe("fetchFile", () => {
	it("fetches file content from the default branch", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/contents/:path+`, () =>
				HttpResponse.json({
					content: Buffer.from("hello world").toString("base64"),
				}),
			),
		);

		const content = await adapter.fetchFile(REPO, "README.md");
		expect(content).toBe("hello world");
	});

	it("passes ref as query param when provided", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/contents/:path+`, ({ request }) => {
				const url = new URL(request.url);
				if (url.searchParams.get("ref") !== "feature-branch") {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json({
					content: Buffer.from("from branch").toString("base64"),
				});
			}),
		);

		const content = await adapter.fetchFile(
			REPO,
			"README.md",
			"feature-branch",
		);

		expect(content).toBe("from branch");
	});

	it("returns null when file does not exist", async () => {
		server.use(
			http.get(
				`${GITHUB_API}/repos/${REPO}/contents/:path+`,
				() => new HttpResponse(null, { status: 404 }),
			),
		);

		const content = await adapter.fetchFile(REPO, "nonexistent.md");
		expect(content).toBeNull();
	});
});

describe("createChangeRequest", () => {
	it("creates a new PR when none exists", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}/pulls`, () =>
				HttpResponse.json([]),
			),
			http.post(`${GITHUB_API}/repos/${REPO}/pulls`, () =>
				HttpResponse.json({
					number: 5,
					html_url: `https://github.com/${REPO}/pull/5`,
				}),
			),
		);

		const result = await adapter.createChangeRequest(
			REPO,
			"agent/issue-1",
			"main",
			"Fix issue 1",
			"Closes #1",
		);

		expect(result).toEqual({
			number: 5,
			url: `https://github.com/${REPO}/pull/5`,
		});
	});

	it("returns existing PR when one already exists for the branch", async () => {
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
				HttpResponse.json(null, { status: 422 }),
			),
		);

		const result = await adapter.createChangeRequest(
			REPO,
			"agent/issue-1",
			"main",
			"Fix issue 1",
			"Closes #1",
		);

		expect(result).toEqual({
			number: 3,
			url: `https://github.com/${REPO}/pull/3`,
		});
	});
});
