import { FetchHttpClient } from "@effect/platform";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { HttpResponse, http } from "msw";
import { describe, expect } from "vitest";
import { GITHUB_API, REPO } from "../test-support/fixtures.ts";
import { server } from "../test-support/msw.ts";
import { createGitHubAdapter } from "./github.ts";

layer(FetchHttpClient.layer)("GitHub adapter", (it) => {
	describe("cloneUrl", () => {
		it.effect("without a clone token, produces a plain HTTPS URL", () =>
			Effect.gen(function* () {
				const adapter = yield* createGitHubAdapter({ token: "test-token" });
				expect(adapter.cloneUrl(REPO)).toBe(
					"https://github.com/test-owner/test-repo.git",
				);
			}),
		);

		it.effect(
			"with a clone token, URL-encodes it into x-access-token basic auth",
			() =>
				Effect.gen(function* () {
					const adapter = yield* createGitHubAdapter({
						token: "test-token",
						cloneToken: "token-with/special:chars",
					});
					expect(adapter.cloneUrl(REPO)).toBe(
						"https://x-access-token:token-with%2Fspecial%3Achars@github.com/test-owner/test-repo.git",
					);
				}),
		);
	});

	describe("repoUrl", () => {
		it.effect("produces an HTTPS URL on github.com", () =>
			Effect.gen(function* () {
				const adapter = yield* createGitHubAdapter({ token: "test-token" });
				expect(adapter.repoUrl(REPO)).toBe(
					"https://github.com/test-owner/test-repo",
				);
			}),
		);
	});

	describe("defaultBranch", () => {
		it.effect("resolves the default branch from the GitHub API", () =>
			Effect.gen(function* () {
				server.use(
					http.get(`${GITHUB_API}/repos/${REPO}`, () =>
						HttpResponse.json({ default_branch: "develop" }),
					),
				);

				const adapter = yield* createGitHubAdapter({ token: "test-token" });
				const branch = yield* adapter.defaultBranch(REPO);
				expect(branch).toBe("develop");
			}),
		);
	});

	describe("createChangeRequest", () => {
		it.effect(
			"when no open PR exists, creates one and returns its number and URL",
			() =>
				Effect.gen(function* () {
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
						http.post(
							`${GITHUB_API}/repos/${REPO}/pulls`,
							async ({ request }) => {
								const body = await request.json();
								if (JSON.stringify(body) !== JSON.stringify(expectedBody)) {
									return new HttpResponse(null, { status: 400 });
								}
								return HttpResponse.json({
									number: 5,
									html_url: `https://github.com/${REPO}/pull/5`,
								});
							},
						),
					);

					const adapter = yield* createGitHubAdapter({ token: "test-token" });
					const result = yield* adapter.createChangeRequest(
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
				}),
		);

		it.effect(
			"when an open PR already exists for the branch, returns it without creating a duplicate",
			() =>
				Effect.gen(function* () {
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

					const adapter = yield* createGitHubAdapter({ token: "test-token" });
					const result = yield* adapter.createChangeRequest(
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
				}),
		);
	});
});
