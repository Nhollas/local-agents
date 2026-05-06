import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../github-client.ts";
import { GITHUB_API, REPO } from "../testing/support/fixtures.ts";
import { server } from "../testing/support/msw.ts";
import { githubToken } from "../types/brands.ts";

describe("GitHub client retry", () => {
	it("retries on 500 and succeeds on the next attempt", async () => {
		server.use(
			http.get(`${GITHUB_API}/repos/${REPO}`, function* () {
				yield new HttpResponse(null, { status: 500 });
				return HttpResponse.json({ default_branch: "main" });
			}),
		);

		const client = createGitHubClient(githubToken("test-token"), {
			baseDelayMs: 1,
		});
		const repo = await client.getRepo(REPO);

		expect(repo).toEqual({ default_branch: "main" });
	});

	it("throws after exhausting all retry attempts", async () => {
		server.use(
			http.get(
				`${GITHUB_API}/repos/${REPO}/contents/:path+`,
				() => new HttpResponse(null, { status: 500 }),
			),
		);

		const client = createGitHubClient(githubToken("test-token"), {
			maxAttempts: 2,
			baseDelayMs: 1,
		});

		await expect(client.getFileContent(REPO, "README.md")).rejects.toThrow(
			"GitHub API GET /repos/test-owner/test-repo/contents/README.md failed (500)",
		);
	});
});
