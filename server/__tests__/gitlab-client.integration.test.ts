import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitLabClient } from "../gitlab-client.ts";
import { GITLAB_API, GITLAB_BASE_URL } from "../testing/support/fixtures.ts";
import { server } from "../testing/support/msw.ts";
import { branchName, gitlabToken, repoSlug } from "../types/brands.ts";

const REPO = repoSlug("group/project");

describe("GitLab client retry", () => {
	it("retries on 500 and succeeds on the next attempt", async () => {
		server.use(
			http.get(`${GITLAB_API}/projects/:project/merge_requests`, function* () {
				yield new HttpResponse(null, { status: 500 });
				return HttpResponse.json([]);
			}),
		);

		const client = createGitLabClient(gitlabToken("test-token"), {
			baseUrl: GITLAB_BASE_URL,
			baseDelayMs: 1,
		});
		const mergeRequests = await client.listMergeRequests(REPO, {
			source_branch: branchName("agent/issue-1"),
			target_branch: branchName("main"),
			state: "opened",
		});

		expect(mergeRequests).toEqual([]);
	});

	it("throws after exhausting all retry attempts", async () => {
		server.use(
			http.get(
				`${GITLAB_API}/projects/:project/repository/files/:file`,
				() => new HttpResponse(null, { status: 500 }),
			),
		);

		const client = createGitLabClient(gitlabToken("test-token"), {
			baseUrl: GITLAB_BASE_URL,
			maxAttempts: 2,
			baseDelayMs: 1,
		});

		await expect(client.getFileContent(REPO, "README.md")).rejects.toThrow(
			"GitLab API GET /projects/group%2Fproject/repository/files/README.md?ref=HEAD failed (500)",
		);
	});
});
