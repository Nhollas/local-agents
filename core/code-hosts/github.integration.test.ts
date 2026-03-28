import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { GITHUB_API, REPO } from "../../tests/support/fixtures.ts";
import { server } from "../../tests/support/msw.ts";
import { createGitHubClient } from "../gh.ts";
import { githubCodeHostAdapter } from "./github.ts";

const adapter = githubCodeHostAdapter(createGitHubClient("test-token"));

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
