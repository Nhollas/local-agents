import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../../github-client.ts";
import {
	createGitHubIssue,
	GITHUB_API,
	REPO,
} from "../../testing/support/fixtures.ts";
import { server } from "../../testing/support/msw.ts";
import { githubToken, issueNumber, repoSlug } from "../../types/brands.ts";
import { githubTrackerAdapter } from "../github.ts";

const TRIGGER = "agent";

describe("githubTrackerAdapter", () => {
	describe("fetchActiveIssues", () => {
		it("pending issues one search per distinct org and stamps repo from repository_url", async () => {
			const captured: string[] = [];
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					const url = new URL(request.url);
					captured.push(url.searchParams.get("q") ?? "");
					return HttpResponse.json({
						total_count: 1,
						items: [
							{
								...createGitHubIssue(10, ["agent"]),
								repository_url: `${GITHUB_API}/repos/${REPO}`,
							},
						],
					});
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(captured).toEqual([
				`org:test-owner type:issue author:test-user state:open label:agent -label:agent:running -label:agent:awaiting-review`,
			]);
			expect(issues).toEqual([
				{
					key: `${REPO}#10`,
					number: 10,
					repo: REPO,
					title: "Issue 10",
					description: "Description for issue 10",
					labels: ["agent"],
					url: `https://github.com/${REPO}/issues/10`,
					createdAt: "2025-01-01T00:00:00Z",
				},
			]);
		});

		it("running issues a scope-wide search with the running state label", async () => {
			const captured: string[] = [];
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					captured.push(new URL(request.url).searchParams.get("q") ?? "");
					return HttpResponse.json({
						total_count: 1,
						items: [createGitHubIssue(11, ["agent", "agent:running"])],
					});
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("running");

			expect(captured).toEqual([
				`org:test-owner type:issue author:test-user state:open label:agent label:agent:running`,
			]);
			expect(issues.map((i) => i.key)).toEqual([`${REPO}#11`]);
		});

		it("awaiting_review issues a scope-wide search with the awaiting-review state label", async () => {
			const captured: string[] = [];
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					captured.push(new URL(request.url).searchParams.get("q") ?? "");
					return HttpResponse.json({
						total_count: 1,
						items: [createGitHubIssue(12, ["agent", "agent:awaiting-review"])],
					});
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("awaiting_review");

			expect(captured).toEqual([
				`org:test-owner type:issue author:test-user state:open label:agent label:agent:awaiting-review`,
			]);
			expect(issues.map((i) => i.key)).toEqual([`${REPO}#12`]);
		});

		it("derives state labels from a custom trigger label across pending and running queries", async () => {
			const captured: string[] = [];
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					captured.push(new URL(request.url).searchParams.get("q") ?? "");
					return HttpResponse.json({ total_count: 0, items: [] });
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: "local-agents",
			});

			await tracker.fetchActiveIssues("pending");
			await tracker.fetchActiveIssues("running");

			expect(captured).toEqual([
				`org:test-owner type:issue author:test-user state:open label:local-agents -label:local-agents:running -label:local-agents:awaiting-review`,
				`org:test-owner type:issue author:test-user state:open label:local-agents label:local-agents:running`,
			]);
		});

		it("issues one search per distinct org and dedupes across orgs", async () => {
			const repoA = repoSlug("acme/widgets");
			const repoB = repoSlug("other-org/services");
			const captured: string[] = [];

			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					const q = new URL(request.url).searchParams.get("q") ?? "";
					captured.push(q);
					if (q.startsWith("org:acme ")) {
						return HttpResponse.json({
							total_count: 1,
							items: [createGitHubIssue(1, ["agent"], undefined, repoA)],
						});
					}
					if (q.startsWith("org:other-org ")) {
						return HttpResponse.json({
							total_count: 1,
							items: [createGitHubIssue(2, ["agent"], undefined, repoB)],
						});
					}
					return HttpResponse.json({ total_count: 0, items: [] });
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [repoA, repoB],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(captured.map((q) => q.split(" ")[0])).toEqual([
				"org:acme",
				"org:other-org",
			]);
			expect(issues.map((i) => ({ key: i.key, repo: i.repo }))).toEqual([
				{ key: `${repoA}#1`, repo: repoA },
				{ key: `${repoB}#2`, repo: repoB },
			]);
		});

		it("scopesReached returns the configured scopes whose org searches succeeded", async () => {
			const acmeRepo = repoSlug("acme/widgets");
			const otherRepo = repoSlug("other-org/services");

			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					const q = new URL(request.url).searchParams.get("q") ?? "";
					if (q.startsWith("org:other-org ")) {
						return new HttpResponse(null, { status: 500 });
					}
					return HttpResponse.json({ total_count: 0, items: [] });
				}),
			);

			const github = createGitHubClient(githubToken("test-token"), {
				maxAttempts: 1,
			});
			const tracker = githubTrackerAdapter(github, {
				scopes: [acmeRepo, otherRepo],
				triggerLabel: TRIGGER,
			});

			const { scopesReached } = await tracker.fetchActiveIssues("pending");

			expect([...scopesReached]).toEqual([acmeRepo]);
		});

		it("admits descendants of a group-prefix scope", async () => {
			const widgetsApp = repoSlug("acme/widgets-app");
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, () =>
					HttpResponse.json({
						total_count: 1,
						items: [createGitHubIssue(20, ["agent"], undefined, widgetsApp)],
					}),
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [repoSlug("acme")],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues.map((i) => ({ key: i.key, repo: i.repo }))).toEqual([
				{ key: `${widgetsApp}#20`, repo: widgetsApp },
			]);
		});

		it("drops issues whose repo does not resolve against any specific-repo scope", async () => {
			const widgets = repoSlug("acme/widgets");
			const sibling = repoSlug("acme/widgets-other");
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, () =>
					HttpResponse.json({
						total_count: 2,
						items: [
							createGitHubIssue(30, ["agent"], undefined, widgets),
							createGitHubIssue(31, ["agent"], undefined, sibling),
						],
					}),
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [widgets],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues.map((i) => ({ key: i.key, repo: i.repo }))).toEqual([
				{ key: `${widgets}#30`, repo: widgets },
			]);
		});

		it("drops issues whose repository_url is missing or unparseable", async () => {
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, () =>
					HttpResponse.json({
						total_count: 3,
						items: [
							{
								...createGitHubIssue(40, ["agent"]),
								repository_url: undefined,
							},
							{
								...createGitHubIssue(41, ["agent"]),
								repository_url: "https://api.github.com/some-other-shape",
							},
							createGitHubIssue(42, ["agent"]),
						],
					}),
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(issues.map((i) => i.key)).toEqual([`${REPO}#42`]);
		});

		it("dedupes issues that appear in more than one activeStates batch", async () => {
			const captured: string[] = [];
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
					captured.push(new URL(request.url).searchParams.get("q") ?? "");
					return HttpResponse.json({
						total_count: 1,
						items: [createGitHubIssue(50, ["agent"])],
					});
				}),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
				activeStates: ["open", "closed"],
			});

			const { issues } = await tracker.fetchActiveIssues("pending");

			expect(captured).toHaveLength(2);
			expect(issues.map((i) => i.key)).toEqual([`${REPO}#50`]);
		});

		it("maps null body to empty string", async () => {
			server.use(
				http.get(`${GITHUB_API}/user`, () =>
					HttpResponse.json({ login: "test-user" }),
				),
				http.get(`${GITHUB_API}/search/issues`, () =>
					HttpResponse.json({
						total_count: 1,
						items: [
							{
								...createGitHubIssue(5, ["agent"]),
								body: null,
							},
						],
					}),
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			const { issues } = await tracker.fetchActiveIssues("pending");
			expect(issues).toEqual([
				{
					key: `${REPO}#5`,
					number: 5,
					repo: REPO,
					title: "Issue 5",
					description: "",
					labels: ["agent"],
					url: `https://github.com/${REPO}/issues/5`,
					createdAt: "2025-01-01T00:00:00Z",
				},
			]);
		});
	});

	describe("transitionState", () => {
		it("pending → running adds the running state label and never touches the trigger label", async () => {
			const calls: { method: string; label: string }[] = [];

			server.use(
				http.delete(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
					({ params }) => {
						calls.push({
							method: "DELETE",
							label: decodeURIComponent(String(params["label"])),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
				http.post(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
					async ({ request }) => {
						const body = (await request.json()) as { labels: string[] };
						for (const label of body.labels) {
							calls.push({ method: "POST", label });
						}
						return HttpResponse.json([]);
					},
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			await tracker.transitionState(
				REPO,
				issueNumber(42),
				"pending",
				"running",
			);

			expect(calls).toEqual([{ method: "POST", label: "agent:running" }]);
		});

		it("running → awaiting_review swaps state labels and never touches the trigger label", async () => {
			const calls: { method: string; label: string }[] = [];

			server.use(
				http.delete(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
					({ params }) => {
						calls.push({
							method: "DELETE",
							label: decodeURIComponent(String(params["label"])),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
				http.post(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
					async ({ request }) => {
						const body = (await request.json()) as { labels: string[] };
						for (const label of body.labels) {
							calls.push({ method: "POST", label });
						}
						return HttpResponse.json([]);
					},
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			await tracker.transitionState(
				REPO,
				issueNumber(42),
				"running",
				"awaiting_review",
			);

			expect(calls).toEqual([
				{ method: "DELETE", label: "agent:running" },
				{ method: "POST", label: "agent:awaiting-review" },
			]);
		});

		it("running → pending removes the running state label and never re-adds the trigger label", async () => {
			const calls: { method: string; label: string }[] = [];

			server.use(
				http.delete(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
					({ params }) => {
						calls.push({
							method: "DELETE",
							label: decodeURIComponent(String(params["label"])),
						});
						return new HttpResponse(null, { status: 204 });
					},
				),
				http.post(
					`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
					async ({ request }) => {
						const body = (await request.json()) as { labels: string[] };
						for (const label of body.labels) {
							calls.push({ method: "POST", label });
						}
						return HttpResponse.json([]);
					},
				),
			);

			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			await tracker.transitionState(
				REPO,
				issueNumber(42),
				"running",
				"pending",
			);

			expect(calls).toEqual([{ method: "DELETE", label: "agent:running" }]);
		});
	});

	describe("parseIssueKey", () => {
		it("parses GitHub issue keys to an issue number", () => {
			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			expect(tracker.parseIssueKey("owner/repo#42")).toEqual({
				ok: true,
				value: {
					number: 42,
				},
			});
		});

		it("returns Err for malformed GitHub issue keys", () => {
			const github = createGitHubClient(githubToken("test-token"));
			const tracker = githubTrackerAdapter(github, {
				scopes: [REPO],
				triggerLabel: TRIGGER,
			});

			expect(tracker.parseIssueKey("owner/repo")).toEqual({
				ok: false,
				error: {
					kind: "invalid_format",
					input: "owner/repo",
					message: "Invalid GitHub issue key: owner/repo",
				},
			});
			expect(tracker.parseIssueKey("owner/repo#42abc")).toEqual({
				ok: false,
				error: {
					kind: "invalid_format",
					input: "owner/repo#42abc",
					message: "Invalid GitHub issue key: owner/repo#42abc",
				},
			});
		});
	});
});
