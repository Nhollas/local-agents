import { FetchHttpClient } from "@effect/platform";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpResponse, http } from "msw";
import { describe, expect } from "vitest";
import { GITLAB_API, GITLAB_BASE_URL } from "../test-support/fixtures.ts";
import { server } from "../test-support/msw.ts";
import { createGitLabAdapter, type GitLabAdapterOptions } from "./gitlab.ts";

layer(FetchHttpClient.layer)("GitLab adapter", (it) => {
	describe("cloneUrl", () => {
		it.effect("without a clone token, produces a plain HTTPS URL", () =>
			Effect.gen(function* () {
				const adapter = yield* createGitLabAdapter(defaultOptions);
				expect(adapter.cloneUrl(REPO)).toBe(
					"https://gitlab.example.test/group/subgroup/project.git",
				);
			}),
		);

		it.effect("with a clone token, URL-encodes it into oauth2 basic auth", () =>
			Effect.gen(function* () {
				const adapter = yield* createGitLabAdapter({
					...defaultOptions,
					cloneToken: "token-with/special:chars",
				});
				expect(adapter.cloneUrl(REPO)).toBe(
					"https://oauth2:token-with%2Fspecial%3Achars@gitlab.example.test/group/subgroup/project.git",
				);
			}),
		);

		it.effect("without a base URL, defaults to gitlab.com", () =>
			Effect.gen(function* () {
				const adapter = yield* createGitLabAdapter({
					token: "test-token",
				});
				expect(adapter.cloneUrl(REPO)).toBe(
					"https://gitlab.com/group/subgroup/project.git",
				);
			}),
		);
	});

	describe("repoUrl", () => {
		it.effect("produces an HTTPS URL using the configured base URL", () =>
			Effect.gen(function* () {
				const adapter = yield* createGitLabAdapter(defaultOptions);
				expect(adapter.repoUrl(REPO)).toBe(
					"https://gitlab.example.test/group/subgroup/project",
				);
			}),
		);
	});

	describe("defaultBranch", () => {
		it.effect("resolves the default branch from the GitLab API", () =>
			Effect.gen(function* () {
				const expectedPath = "/api/v4/projects/group%2Fsubgroup%2Fproject";

				server.use(
					http.get(`${GITLAB_API}/projects/:project`, ({ request }) => {
						const url = new URL(request.url);
						if (
							url.pathname !== expectedPath ||
							request.headers.get("PRIVATE-TOKEN") !== "test-token"
						) {
							return new HttpResponse(null, {
								status: 400,
							});
						}
						return HttpResponse.json({
							default_branch: "develop",
						});
					}),
				);

				const adapter = yield* createGitLabAdapter(defaultOptions);
				const branch = yield* adapter.defaultBranch(REPO);
				expect(branch).toBe("develop");
			}),
		);
	});

	describe("createChangeRequest", () => {
		it.effect(
			"when no open MR exists, creates one and returns its number and URL",
			() =>
				Effect.gen(function* () {
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

					const adapter = yield* createGitLabAdapter(defaultOptions);
					const result = yield* adapter.createChangeRequest(
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
				}),
		);

		it.effect(
			"when an open MR already exists for the branch, returns it without creating a duplicate",
			() =>
				Effect.gen(function* () {
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

					const adapter = yield* createGitLabAdapter(defaultOptions);
					const result = yield* adapter.createChangeRequest(
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
				}),
		);
	});
});

const REPO = "group/subgroup/project";

const defaultOptions: GitLabAdapterOptions = {
	token: "test-token",
	baseUrl: GITLAB_BASE_URL,
};
