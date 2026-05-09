import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { GITLAB_API, GITLAB_BASE_URL } from "../test-support/fixtures.ts";
import { server } from "../test-support/msw.ts";
import { repoSlug } from "../types/brands.ts";
import { gitlabCodeHostAdapter } from "./gitlab.ts";
import { createGitLabClient } from "./gitlab-client.ts";

const REPO = repoSlug("group/subgroup/project");
const adapter = gitlabCodeHostAdapter(
	createGitLabClient("test-token", { baseUrl: GITLAB_BASE_URL }),
);

describe("cloneUrl", () => {
	it("uses the configured base URL", () => {
		expect(adapter.cloneUrl(REPO)).toBe(
			"https://gitlab.example.test/group/subgroup/project.git",
		);
	});

	it("embeds the configured token as HTTP basic auth when provided", () => {
		const tokenAdapter = gitlabCodeHostAdapter(
			createGitLabClient("test-token", {
				baseUrl: GITLAB_BASE_URL,
			}),
			"token-with/special:chars",
		);

		expect(tokenAdapter.cloneUrl(REPO)).toBe(
			"https://oauth2:token-with%2Fspecial%3Achars@gitlab.example.test/group/subgroup/project.git",
		);
	});

	it("defaults to gitlab.com when no base URL is configured", () => {
		const defaultAdapter = gitlabCodeHostAdapter(
			createGitLabClient("test-token"),
		);

		expect(defaultAdapter.cloneUrl(REPO)).toBe(
			"https://gitlab.com/group/subgroup/project.git",
		);
	});
});

describe("defaultBranch", () => {
	it("returns the project's default_branch from the GitLab project endpoint", async () => {
		const expectedPath = "/api/v4/projects/group%2Fsubgroup%2Fproject";

		server.use(
			http.get(`${GITLAB_API}/projects/:project`, ({ request }) => {
				const url = new URL(request.url);
				if (
					url.pathname !== expectedPath ||
					request.headers.get("PRIVATE-TOKEN") !== "test-token"
				) {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json({ default_branch: "develop" });
			}),
		);

		await expect(adapter.defaultBranch(REPO)).resolves.toBe("develop");
	});
});

describe("createChangeRequest", () => {
	it("creates a new MR when none exists", async () => {
		const expectedBody = {
			source_branch: "agent/issue-1",
			target_branch: "main",
			title: "Fix issue 1",
			description: "Closes TEST-1",
		};

		server.use(
			http.get(
				`${GITLAB_API}/projects/:project/merge_requests`,
				({ request }) => {
					const params = new URL(request.url).searchParams;
					if (
						params.get("source_branch") !== "agent/issue-1" ||
						params.get("target_branch") !== "main" ||
						params.get("state") !== "opened"
					) {
						return new HttpResponse(null, { status: 400 });
					}
					return HttpResponse.json([]);
				},
			),
			http.post(
				`${GITLAB_API}/projects/:project/merge_requests`,
				async ({ request }) => {
					const body = await request.json();
					if (JSON.stringify(body) !== JSON.stringify(expectedBody)) {
						return new HttpResponse(null, { status: 400 });
					}
					return HttpResponse.json({
						iid: 5,
						web_url: `${GITLAB_BASE_URL}/${REPO}/-/merge_requests/5`,
					});
				},
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
			number: 5,
			url: `${GITLAB_BASE_URL}/${REPO}/-/merge_requests/5`,
		});
	});

	it("returns an existing MR for the source branch", async () => {
		server.use(
			http.get(`${GITLAB_API}/projects/:project/merge_requests`, () =>
				HttpResponse.json([
					{
						iid: 3,
						web_url: `${GITLAB_BASE_URL}/${REPO}/-/merge_requests/3`,
					},
				]),
			),
			http.post(`${GITLAB_API}/projects/:project/merge_requests`, () =>
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
			url: `${GITLAB_BASE_URL}/${REPO}/-/merge_requests/3`,
		});
	});
});
