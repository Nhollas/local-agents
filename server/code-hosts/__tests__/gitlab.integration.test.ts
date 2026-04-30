import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitLabClient } from "../../gitlab-client.ts";
import { GITLAB_API, GITLAB_BASE_URL } from "../../testing/support/fixtures.ts";
import { server } from "../../testing/support/msw.ts";
import { gitlabCodeHostAdapter } from "../gitlab.ts";

const REPO = "group/subgroup/project";
const adapter = gitlabCodeHostAdapter(
	createGitLabClient("test-token", { baseUrl: GITLAB_BASE_URL }),
	GITLAB_BASE_URL,
);

describe("cloneUrl", () => {
	it("uses the configured base URL", () => {
		expect(adapter.cloneUrl(REPO)).toBe(
			"https://gitlab.example.test/group/subgroup/project.git",
		);
	});

	it("defaults to gitlab.com when no base URL is configured", async () => {
		const defaultAdapter = gitlabCodeHostAdapter(
			createGitLabClient("test-token"),
		);

		server.use(
			http.get(
				"https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fproject/repository/files/README.md",
				() =>
					HttpResponse.json({
						content: Buffer.from("default base").toString("base64"),
					}),
			),
		);

		await expect(defaultAdapter.fetchFile(REPO, "README.md")).resolves.toBe(
			"default base",
		);
		expect(defaultAdapter.cloneUrl(REPO)).toBe(
			"https://gitlab.com/group/subgroup/project.git",
		);
	});
});

describe("fetchFile", () => {
	it("fetches file content through the encoded GitLab project and file API path", async () => {
		const expectedPath =
			"/api/v4/projects/group%2Fsubgroup%2Fproject/repository/files/docs%2Fguide.md";

		server.use(
			http.get(
				`${GITLAB_API}/projects/:project/repository/files/:file`,
				({ request }) => {
					const url = new URL(request.url);
					if (
						url.pathname !== expectedPath ||
						url.searchParams.get("ref") !== "feature/gitlab" ||
						request.headers.get("PRIVATE-TOKEN") !== "test-token"
					) {
						return new HttpResponse(null, { status: 400 });
					}
					return HttpResponse.json({
						content: Buffer.from("hello from gitlab").toString("base64"),
					});
				},
			),
		);

		const content = await adapter.fetchFile(
			REPO,
			"docs/guide.md",
			"feature/gitlab",
		);

		expect(content).toBe("hello from gitlab");
	});

	it("returns null when the GitLab file does not exist", async () => {
		server.use(
			http.get(
				`${GITLAB_API}/projects/:project/repository/files/:file`,
				() => new HttpResponse(null, { status: 404 }),
			),
		);

		const content = await adapter.fetchFile(REPO, "missing.md");
		expect(content).toBeNull();
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
